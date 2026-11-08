import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { cardView, groupView, openPanel, stateMessage, threadView } from '../harness';
import { GROK_MCP_WAIT } from '../../core/grok/mcp';

const accounts = (): AccountView[] => [
  {
    brand: 'claude',
    name: 'Claude',
    mark: 'claude',
    state: 'signed_in',
    label: 'reader@example.com',
    detail: 'Claude · 1 session'
  },
  {
    brand: 'grok',
    name: 'Grok',
    mark: 'grok',
    state: 'signed_in',
    label: 'reader@x.ai',
    detail: 'Grok · 1 session'
  },
  { brand: 'codex', name: 'Codex', mark: 'codex', state: 'coming_soon', detail: 'Coming soon' }
];

const actionRef = (
  brand: BrandId,
  name = 'linear',
  root = '/repos/acme-web',
  key = name === 'linear' ? 'https://mcp.linear.app/mcp' : `https://mcp.${name}.com/mcp`
): McpActionRef => ({
  brand,
  name,
  key,
  declaration: { scope: 'project', root },
  readCwd: root
});

const cell = (
  brand: BrandId,
  state: McpBrandCell['state'],
  over: Partial<McpBrandCell> = {}
): McpBrandCell => {
  const name = over.name ?? 'linear';
  const root = over.root ?? '/repos/acme-web';
  return {
    brand,
    name,
    label: brand === 'claude' ? 'Claude' : brand === 'grok' ? 'Grok' : 'Codex',
    mark: brand,
    state,
    supported: true,
    // What `mcp_sheet.ts` used to derive. Stamping it here keeps every scenario
    // written before the flag existed asserting the verb it already asserted.
    canDisconnect: !over.fromAccount && (state === 'ok' || state === 'broken'),
    target: actionRef(brand, name, root),
    ...over
  };
};

const group = (over: Partial<McpGroupView> = {}): McpGroupView => ({
  root: '/repos/acme-web',
  label: 'acme-web',
  path: '~/repos/acme-web',
  here: true,
  servers: [],
  ...over
});

/**
 * A scenario's overrides. `servers` is not a field of the view any more — the
 * rows live in a section — so it stays here as the shorthand every scenario
 * about a row is written in.
 */
type Over = Partial<McpView> & { servers?: McpServerView[] };

/**
 * The sheet, with one section holding whatever `servers` ends up being.
 *
 * **Sections are synthesised rather than asked for**, so a scenario about
 * arming, disarming or the footer keeps saying what it said before the sheet
 * was cut into sections — those scenarios are about a row, and a row is now
 * inside a section by construction. A scenario that is about the sections
 * passes `groups` and `servers` will not be looked at.
 */
const mcp = (over: Over = {}): McpView => {
  const { servers, ...rest } = over;
  const view: McpView = {
    hint: 'Each brand is its own login. Authorising Claude does not unlock Grok.',
    summary: 'Notion needs Claude',
    groups: [],
    ...rest
  };
  if (over.groups) return view;
  const rows = servers ?? [
    {
      name: 'linear',
      key: 'https://mcp.linear.app/mcp',
      host: 'mcp.linear.app',
      projects: ['acme-web'],
      brands: [cell('claude', 'ok'), cell('grok', 'ok')]
    },
    {
      name: 'notion',
      key: 'https://mcp.notion.com/mcp',
      host: 'mcp.notion.com',
      projects: ['acme-web'],
      brands: [cell('claude', 'needs', { name: 'notion' })]
    }
  ];
  return { ...view, groups: [group({ servers: rows })] };
};

const lastAction = (p: ReturnType<typeof openPanel>): unknown => {
  const { operationId, ...message } = p.posted.at(-1) as WebviewMessage & { operationId?: string };
  if (message.type === 'startMcpLogin' || message.type === 'mcpLogout')
    assert.equal(typeof operationId, 'string', 'MCP actions identify their reply');
  return message;
};

const actOn = (row: HTMLElement | undefined): HTMLButtonElement | null =>
  row?.querySelector<HTMLButtonElement>('button.ba, button.act') ?? null;

const openMenu = (t: Parameters<typeof openPanel>[0], over: Over = {}) => {
  const p = openPanel(t);
  p.push(
    stateMessage([groupView({ sessions: [cardView()] })], { accounts: accounts(), mcp: mcp(over) })
  );
  p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
  const menu = p.window.document.querySelector<HTMLElement>(
    '#nav-actions .smenu.accts:not([hidden])'
  );
  assert.ok(menu, 'accounts flyout');
  return { p, menu };
};

const openMcp = (t: Parameters<typeof openPanel>[0], over: Over = {}) => {
  const { p, menu } = openMenu(t, over);
  menu.querySelector<HTMLElement>('.mcpfoot')?.click();
  const sheet = p.window.document.querySelector<HTMLElement>('#mscrim:not([hidden])');
  assert.ok(sheet, 'mcp sheet');
  return { p, menu, sheet };
};

const cells = (sheet: HTMLElement): HTMLElement[] => [
  ...sheet.querySelectorAll<HTMLElement>('.bcell:not(.absent)')
];

describe('mcp servers — the accounts popover', () => {
  it('draws a footer from the summary, and no server rows', (t) => {
    const { menu } = openMenu(t);
    assert.match(menu.textContent ?? '', /MCP/);
    assert.match(menu.textContent ?? '', /Notion needs Claude/);
    assert.equal(menu.querySelector('.mcpsec'), null);
    assert.equal(menu.querySelectorAll('.acct .mcpdot').length, 0);
    assert.doesNotMatch(menu.textContent ?? '', /Authorised once per machine/);
  });

  it('does not draw the footer amber for a server only its own repo can approve', (t) => {
    const { menu } = openMenu(t, { summary: 'Notion is not approved', summaryWants: false });
    const row = menu.querySelector('.mcpgo');
    assert.ok(row);
    assert.equal(row.classList.contains('needs'), false, 'nothing here is the fix');
  });

  it('opens the sheet from the footer', (t) => {
    const { sheet } = openMcp(t);
    assert.match(sheet.textContent ?? '', /MCP servers/);
    assert.match(sheet.textContent ?? '', /linear/);
    assert.match(sheet.textContent ?? '', /mcp\.linear\.app/);
    // The repo is the section head now, not a comma-joined tail on the row.
    assert.equal(sheet.querySelector('.rsec .rname')?.textContent, 'acme-web');
  });

  it('draws nothing MCP when the read never landed', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView()] })], { accounts: accounts() }));
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu);
    assert.equal(menu.querySelector('.mcpfoot'), null);
    assert.doesNotMatch(menu.textContent ?? '', /MCP servers/);
  });

  it('hides the footer when there are no servers', (t) => {
    const { menu } = openMenu(t, { servers: [], summary: undefined });
    assert.equal(menu.querySelector('.mcpfoot'), null);
  });
});

describe('mcp servers — the sheet', () => {
  it('owns one Escape above an open workflow overview drawer', (t) => {
    const { p, sheet } = openMcp(t);
    const card = cardView();
    p.push({ type: 'reveal', pid: card.pid, startedAt: card.startedAt });
    p.push(
      stateMessage([groupView({ sessions: [card] })], {
        accounts: accounts(),
        mcp: mcp(),
        thread: threadView({
          pid: card.pid,
          startedAt: card.startedAt,
          workflow: { label: 'Build', steps: [{ id: 'build', label: 'Build', status: 'pending' }] }
        })
      })
    );
    p.window.document.querySelector<HTMLElement>('#wattach .wflow.live')?.click();
    const drawer = p.window.document.getElementById('workflowoverviewdrawer');
    assert.equal(drawer?.hidden, false, 'drawer did not open from the dock');
    assert.equal(sheet.hidden, false, 'MCP closed while opening the drawer');
    sheet.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(sheet.hidden, true, 'MCP did not take Escape');
    assert.equal(drawer?.hidden, false, 'Escape also closed the drawer under MCP');
    p.window.document.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    assert.equal(drawer?.hidden, true, 'drawer did not take the next Escape');
  });

  for (const [state, status] of [
    ['ok', 'Connected'],
    ['needs', 'Needs auth'],
    ['broken', 'Unreachable'],
    ['pending', 'Not approved'],
    ['unknown', 'Not checked'],
    ['error', 'Failed'],
    ['busy', 'Waiting']
  ] as const) {
    it(`keeps the ${state} pill short when the cell has a note`, (t) => {
      const note = state === 'busy' ? GROK_MCP_WAIT : 'No MCP server named "gone-mcp"';
      const { sheet } = openMcp(t, {
        servers: [
          {
            name: 'gone-mcp',
            key: 'https://mcp.gone.test/mcp',
            host: 'mcp.gone.test',
            projects: ['acme-web'],
            brands: [cell('grok', state, { name: 'gone-mcp', note })]
          }
        ]
      });
      assert.equal(cells(sheet)[0]?.querySelector('.bs')?.textContent, status);
      if (state === 'error' || state === 'busy') {
        assert.equal(
          sheet.querySelector(`.bdetail .${state === 'busy' ? 'wait' : 'why'}`)?.textContent,
          note
        );
        assert.equal(sheet.querySelectorAll('.bdetail').length, 1);
        assert.equal(actOn(cells(sheet)[0])?.textContent, state === 'busy' ? 'Cancel' : 'Retry');
      }
    });
  }

  it('draws a brand mark for a host we have one for, and the bare mark otherwise', (t) => {
    const { sheet } = openMcp(t, {
      summary: 'Slack needs Grok',
      servers: [
        {
          name: 'linear',
          key: 'https://mcp.linear.app/mcp',
          host: 'mcp.linear.app',
          projects: ['acme-web'],
          brands: [cell('claude', 'ok')]
        },
        {
          name: 'work-chat',
          key: 'https://mcp.slack.com/mcp',
          host: 'mcp.slack.com',
          projects: ['acme-web'],
          brands: [cell('grok', 'needs', { name: 'work-chat' })]
        },
        {
          name: 'notion',
          key: 'https://mcp.notion.com/mcp',
          host: 'mcp.notion.com',
          projects: ['acme-web'],
          brands: [cell('claude', 'ok', { name: 'notion' })]
        }
      ]
    });
    assert.ok(sheet.querySelector('.srow .mcpmark svg.bm.ln'), 'linear mark');
    assert.ok(sheet.querySelector('.srow .mcpmark svg.bm.sl'), 'slack mark');
    const notion = [...sheet.querySelectorAll('.srow')].find((r) =>
      r.textContent?.includes('notion')
    );
    assert.equal(notion?.querySelector('.mcpmark'), null, 'no mark for an unknown host');
  });

  it('draws two cells on a mixed Claude-ok / Grok-needs row', (t) => {
    const { sheet } = openMcp(t, {
      summary: 'Slack needs Grok',
      servers: [
        {
          name: 'slack',
          key: 'https://mcp.slack.com/mcp',
          host: 'mcp.slack.com',
          projects: ['acme-web'],
          brands: [
            cell('claude', 'ok', { name: 'slack' }),
            cell('grok', 'needs', { name: 'slack' })
          ]
        }
      ]
    });
    const [claude, grok] = cells(sheet);
    assert.ok(claude?.classList.contains('ok'));
    assert.equal(actOn(claude)?.textContent, 'Disconnect');
    assert.ok(grok?.classList.contains('needs'));
    assert.equal(actOn(grok)?.textContent, 'Authorise');
  });

  it('aligns every server against one stable column per CLI', (t) => {
    const { sheet } = openMcp(t, {
      servers: [
        {
          name: 'linear',
          key: 'https://mcp.linear.app/mcp',
          host: 'mcp.linear.app',
          projects: ['acme-web'],
          brands: [cell('claude', 'ok')]
        }
      ]
    });
    const labels = [...sheet.querySelectorAll<HTMLElement>('.mchead > *')].map((node) =>
      node.textContent?.trim()
    );
    assert.deepEqual(labels, ['Server', 'Claude', 'Grok', 'Codex']);

    const row = sheet.querySelector<HTMLElement>('.srow');
    assert.ok(row);
    const brandCells = [...row.children].filter((node) => node.classList.contains('bcell'));
    assert.equal(brandCells.length, 3);
    assert.equal(brandCells[1]?.getAttribute('aria-label'), 'Grok: Not listed');
    assert.equal(brandCells[2]?.getAttribute('aria-label'), 'Codex: Not listed');
  });

  it('posts startMcpLogin with the cell brand', (t) => {
    const { p, sheet } = openMcp(t, {
      summary: 'Slack needs Grok',
      servers: [
        {
          name: 'slack',
          key: 'https://mcp.slack.com/mcp',
          host: 'mcp.slack.com',
          projects: ['acme-web'],
          brands: [
            cell('claude', 'ok', { name: 'slack' }),
            cell('grok', 'needs', { name: 'slack' })
          ]
        }
      ]
    });
    actOn(cells(sheet)[1])?.click();
    assert.deepEqual(lastAction(p), {
      type: 'startMcpLogin',
      target: actionRef('grok', 'slack', '/repos/acme-web', 'https://mcp.slack.com/mcp')
    });
  });

  it('offers Disconnect on an authorised cell, and nothing to authorise', (t) => {
    const linear = cells(openMcp(t).sheet)[0];
    assert.ok(linear);
    assert.ok(linear.classList.contains('ok'));
    assert.equal(linear.querySelector('button.ba.fix'), null, 'nothing to authorise');
    assert.equal(actOn(linear)?.textContent, 'Disconnect');
  });

  it('arms Disconnect on the first press and posts nothing', (t) => {
    const { p, sheet } = openMcp(t);
    const before = p.posted.length;
    actOn(cells(sheet)[0])?.click();
    assert.equal(p.posted.length, before, 'nothing posted while only armed');
    assert.equal(actOn(cells(sheet)[0])?.textContent, 'Disconnect?');
  });

  it('posts mcpLogout with the brand on the second press', (t) => {
    const { p, sheet } = openMcp(t);
    actOn(cells(sheet)[0])?.click();
    actOn(cells(sheet)[0])?.click();
    assert.deepEqual(lastAction(p), { type: 'mcpLogout', target: actionRef('claude') });
  });

  it('keeps Disconnect pending until the host has answered', (t) => {
    const { p, sheet } = openMcp(t);
    actOn(cells(sheet)[0])?.click();
    actOn(cells(sheet)[0])?.click();
    const posted = p.posted.length;
    assert.equal(actOn(cells(sheet)[0])?.disabled, true, 'pending on the spot');
    assert.match(cells(sheet)[0]?.textContent ?? '', /Disconnecting/);
    actOn(cells(sheet)[0])?.click();
    assert.equal(p.posted.length, posted, 'a third press cannot submit again');
  });

  it('keeps the cell armed across a repaint of the body', (t) => {
    const { p, sheet } = openMcp(t);
    actOn(cells(sheet)[0])?.click();
    const before = actOn(cells(sheet)[0]);
    p.push(
      stateMessage([groupView({ sessions: [cardView()] })], {
        accounts: accounts(),
        mcp: mcp({
          servers: [
            {
              name: 'linear',
              key: 'https://mcp.linear.app/mcp',
              host: 'mcp.linear.app',
              projects: ['acme-web'],
              brands: [cell('claude', 'ok'), cell('grok', 'ok')]
            },
            {
              name: 'notion',
              key: 'https://mcp.notion.com/mcp',
              host: 'mcp.notion.com',
              projects: ['acme-web'],
              brands: [cell('claude', 'error', { name: 'notion', note: 'nope' })]
            }
          ]
        })
      })
    );
    const after = actOn(cells(sheet)[0]);
    assert.notEqual(after, before, 'the body really was replaced');
    assert.equal(after?.textContent, 'Disconnect?', 'still armed');
    after?.click();
    assert.deepEqual(lastAction(p), { type: 'mcpLogout', target: actionRef('claude') });
  });

  it('disarms a cell that stops being connected', (t) => {
    const { p, sheet } = openMcp(t);
    actOn(cells(sheet)[0])?.click();
    const away = (state: 'needs' | 'ok'): McpView =>
      mcp({
        summary: state === 'ok' ? 'All connected' : 'Linear needs Claude',
        servers: [
          {
            name: 'linear',
            key: 'https://mcp.linear.app/mcp',
            host: 'mcp.linear.app',
            projects: ['acme-web'],
            brands: [cell('claude', state)]
          }
        ]
      });
    const push = (view: McpView) =>
      p.push(
        stateMessage([groupView({ sessions: [cardView()] })], { accounts: accounts(), mcp: view })
      );
    push(away('needs'));
    push(away('ok'));
    assert.equal(actOn(cells(sheet)[0])?.textContent, 'Disconnect', 'came back unarmed');
  });

  it('arms one cell at a time', (t) => {
    const { sheet } = openMcp(t, {
      summary: 'All connected',
      servers: [
        {
          name: 'linear',
          key: 'https://mcp.linear.app/mcp',
          host: 'mcp.linear.app',
          projects: ['r'],
          brands: [cell('claude', 'ok'), cell('grok', 'ok')]
        }
      ]
    });
    actOn(cells(sheet)[0])?.click();
    actOn(cells(sheet)[1])?.click();
    assert.equal(actOn(cells(sheet)[0])?.textContent, 'Disconnect');
    assert.equal(actOn(cells(sheet)[1])?.textContent, 'Disconnect?');
  });

  it('shows the url with Open once a Claude login is in flight, and posts openLoginUrl', (t) => {
    const { p, sheet } = openMcp(t, {
      summary: 'Notion needs Claude',
      servers: [
        {
          name: 'notion',
          key: 'https://mcp.notion.com/mcp',
          host: 'mcp.notion.com',
          projects: ['acme-web'],
          brands: [
            cell('claude', 'busy', {
              name: 'notion',
              note: 'Open this to authorise, then come back',
              url: 'https://mcp.notion.com/authorize?code_challenge=abc'
            })
          ]
        }
      ]
    });
    assert.match(sheet.textContent ?? '', /Open this to authorise/);
    assert.equal(cells(sheet)[0]?.querySelector('.bs')?.textContent, 'Browser opened');
    assert.equal(
      sheet.querySelector('.bdetail .wait')?.textContent,
      'Open this to authorise, then come back'
    );
    const open = sheet.querySelector<HTMLButtonElement>('.mcpurl .aurl .b.pri');
    assert.ok(open, 'Open button on the url block');
    open.click();
    assert.deepEqual(lastAction(p), {
      type: 'openLoginUrl',
      url: 'https://mcp.notion.com/authorize?code_challenge=abc'
    });
  });

  it('names the brand once under a cell holding both a wait and a url', (t) => {
    const { sheet } = openMcp(t, {
      summary: 'Slack needs Claude',
      servers: [
        {
          name: 'slack',
          key: 'https://mcp.slack.com/mcp',
          host: 'mcp.slack.com',
          projects: ['acme-web'],
          brands: [
            cell('claude', 'busy', {
              name: 'slack',
              note: 'Waiting for authorisation…',
              url: 'https://mcp.slack.com/oauth/v2_user/authorize?response_type=code'
            })
          ]
        }
      ]
    });
    assert.equal(sheet.querySelectorAll('.bdetail').length, 1, 'one line for one cell');
    assert.equal(sheet.querySelectorAll('.bdbrand').length, 1, 'and it says Claude once');
    assert.match(sheet.textContent ?? '', /Waiting for authorisation/);
    assert.ok(sheet.querySelector('.mcpurl .aurl .b.pri'), 'the url block is on that line');
  });

  it('says the wait on an in-flight Grok cell, and draws no url', (t) => {
    const { sheet } = openMcp(t, {
      summary: 'Slack needs Grok',
      servers: [
        {
          name: 'slack',
          key: 'https://mcp.slack.com/mcp',
          host: 'mcp.slack.com',
          projects: ['acme-web'],
          brands: [
            cell('grok', 'busy', {
              name: 'slack',
              note: GROK_MCP_WAIT
            })
          ]
        }
      ]
    });
    assert.match(sheet.textContent ?? '', /Asked Grok for the grant/);
    assert.equal(sheet.querySelector('.mcpurl'), null, 'no url block for Grok');
    assert.equal(actOn(cells(sheet)[0])?.textContent, 'Cancel');
  });

  it('offers Cancel while in flight, and posts cancelMcpLogin', (t) => {
    const { p, sheet } = openMcp(t, {
      summary: 'Notion needs Claude',
      servers: [
        {
          name: 'notion',
          key: 'https://mcp.notion.com/mcp',
          host: 'mcp.notion.com',
          projects: ['x'],
          brands: [cell('claude', 'busy', { name: 'notion', note: 'Starting…' })]
        }
      ]
    });
    const cancel = [...sheet.querySelectorAll<HTMLButtonElement>('button.ba')].find(
      (b) => b.textContent === 'Cancel'
    );
    assert.ok(cancel, 'Cancel button');
    cancel.click();
    assert.deepEqual(lastAction(p), { type: 'cancelMcpLogin' });
  });

  it('offers Retry after a failed authorisation', (t) => {
    const { p, sheet } = openMcp(t, {
      summary: 'Notion needs Claude',
      servers: [
        {
          name: 'notion',
          key: 'https://mcp.notion.com/mcp',
          host: 'mcp.notion.com',
          projects: ['x'],
          brands: [
            cell('claude', 'error', { name: 'notion', note: 'Authorisation did not finish.' })
          ]
        }
      ]
    });
    const retry = sheet.querySelector<HTMLButtonElement>('button.ba.fix');
    assert.equal(retry?.textContent, 'Retry');
    retry?.click();
    assert.deepEqual(lastAction(p), {
      type: 'startMcpLogin',
      target: actionRef('claude', 'notion', '/repos/acme-web', 'https://mcp.notion.com/mcp')
    });
  });

  it('drops the button but keeps the state where the host cannot run the login', (t) => {
    const { sheet } = openMcp(t, {
      hint: 'Authorising Claude is not available on this host. Run claude mcp login in a terminal instead.',
      servers: [
        {
          name: 'notion',
          key: 'https://mcp.notion.com/mcp',
          host: 'mcp.notion.com',
          projects: ['acme-web'],
          brands: [cell('claude', 'needs', { name: 'notion', supported: false })]
        }
      ]
    });
    assert.match(sheet.textContent ?? '', /notion/);
    assert.match(sheet.textContent ?? '', /Needs auth/);
    assert.equal(sheet.querySelector('button.ba.fix'), null, 'no Authorise off darwin');
    assert.match(sheet.textContent ?? '', /claude mcp login/);
  });

  it('follows the login through, with the sheet open the whole time', (t) => {
    const { p, sheet } = openMcp(t);
    const busy = (note: string, url?: string): McpView =>
      mcp({
        summary: 'Notion needs Claude',
        servers: [
          {
            name: 'notion',
            key: 'https://mcp.notion.com/mcp',
            host: 'mcp.notion.com',
            projects: ['acme-web'],
            brands: [
              cell('claude', 'busy', {
                name: 'notion',
                note,
                ...(url ? { url } : {})
              })
            ]
          }
        ]
      });
    const push = (mcpView: McpView) =>
      p.push(
        stateMessage([groupView({ sessions: [cardView()] })], {
          accounts: accounts(),
          mcp: mcpView
        })
      );

    sheet.querySelector<HTMLButtonElement>('button.ba.fix')?.click();
    assert.deepEqual(lastAction(p), {
      type: 'startMcpLogin',
      target: actionRef('claude', 'notion', '/repos/acme-web', 'https://mcp.notion.com/mcp')
    });

    const operationId = (p.posted.at(-1) as { operationId: string }).operationId;
    push(busy('Starting…'));
    assert.match(sheet.textContent ?? '', /Starting…/, 'starting reaches the open sheet');

    push(
      busy('Open this to authorise, then come back', 'https://mcp.notion.com/a?code_challenge=x')
    );
    const open = sheet.querySelector<HTMLButtonElement>('.mcpurl .aurl .b.pri');
    assert.ok(open, 'the url block appears without reopening the sheet');
    open.click();
    assert.deepEqual(lastAction(p), {
      type: 'openLoginUrl',
      url: 'https://mcp.notion.com/a?code_challenge=x'
    });

    push(busy('Waiting for authorisation…'));
    assert.match(sheet.textContent ?? '', /Waiting for authorisation…/);
    assert.equal(sheet.querySelector('.mcpurl'), null, 'url block goes when the url does');

    push(
      mcp({
        summary: 'All connected',
        servers: [
          {
            name: 'notion',
            key: 'https://mcp.notion.com/mcp',
            host: 'mcp.notion.com',
            projects: ['acme-web'],
            brands: [cell('claude', 'ok', { name: 'notion' })]
          }
        ]
      })
    );
    p.push({ type: 'mcpActionProgress', operationId, phase: 'done' });
    assert.equal(actOn(cells(sheet)[0])?.textContent, 'Disconnect', 'and the cell settles');
    assert.equal(
      p.window.document.querySelectorAll('#mscrim').length,
      1,
      'one sheet, not appended'
    );
  });

  it('leaves the body alone when nothing about it moved', (t) => {
    const { p, sheet } = openMcp(t);
    const body = sheet.querySelector('.asbody');
    const button = sheet.querySelector('button.ba.fix');
    assert.ok(body && button);
    for (const cpu of [0.1, 0.4, 0.9]) {
      p.push(
        stateMessage([groupView({ sessions: [cardView()] })], {
          accounts: accounts(),
          mcp: mcp(),
          machine: { cpu, memory: { used: 8, total: 16 } }
        })
      );
    }
    assert.equal(sheet.querySelector('.asbody'), body, 'same body node');
    assert.equal(sheet.querySelector('button.ba.fix'), button, 'same button to press');
  });

  it('names the brand once under an armed cell that also has a reason', (t) => {
    // The same collapse the busy cell got, on the other path that can draw two
    // parts: the reach of a shared login, and why the CLI cannot reach it.
    const { sheet } = openMcp(t, {
      summary: 'All connected',
      servers: [
        {
          name: 'linear',
          key: 'https://mcp.linear.app/mcp',
          host: 'mcp.linear.app',
          projects: ['acme-web', 'shop'],
          alsoIn: ['shop'],
          brands: [cell('claude', 'broken', { note: 'Connection failed' })]
        }
      ]
    });
    actOn(cells(sheet)[0])?.click();
    assert.equal(actOn(cells(sheet)[0])?.textContent, 'Disconnect?', 'armed');
    assert.equal(sheet.querySelectorAll('.bdetail').length, 1, 'one line for one cell');
    assert.equal(sheet.querySelectorAll('.bdbrand').length, 1, 'and it says Claude once');
    assert.match(sheet.textContent ?? '', /this takes it for acme-web and shop/);
    assert.match(sheet.textContent ?? '', /Connection failed/);
  });

  /** A server the CLI cannot reach, and one nobody has approved. Neither is a
   *  login problem, and the sheet used to call both of them Connected. */
  const oneCell = (state: McpBrandCell['state'], note?: string): Over => ({
    summary: 'All connected',
    servers: [
      {
        name: 'sentry',
        key: 'https://mcp.sentry.dev/sse',
        host: 'mcp.sentry.dev',
        projects: ['shop'],
        brands: [
          cell('claude', state, {
            ...(note ? { note } : {}),
            target: actionRef('claude', 'sentry', '/repos/acme-web', 'https://mcp.sentry.dev/sse')
          })
        ]
      }
    ]
  });

  it('posts the root a cell came from, so a verb reaches the right repo', (t) => {
    // One name, two repos, two urls: each brand keys its token by name *and*
    // url hash, so a name alone can authorise the url nobody was looking at.
    const { p, sheet } = openMcp(t, {
      summary: 'All connected',
      servers: [
        {
          name: 'linear',
          key: 'https://mcp.linear.app/mcp',
          host: 'mcp.linear.app',
          projects: ['shop'],
          brands: [cell('claude', 'ok', { root: '/Users/x/shop' })]
        }
      ]
    });
    actOn(cells(sheet)[0])?.click();
    actOn(cells(sheet)[0])?.click();
    assert.deepEqual(lastAction(p), {
      type: 'mcpLogout',
      target: actionRef('claude', 'linear', '/Users/x/shop')
    });
  });

  it('says what is wrong with a broken cell rather than calling it connected', (t) => {
    const { sheet } = openMcp(t, oneCell('broken', 'HTTP 200: SSE error: Invalid content type'));
    assert.match(sheet.textContent ?? '', /Invalid content type/);
    assert.doesNotMatch(sheet.textContent ?? '', /Connected/);
  });

  it('keeps Disconnect on a broken cell and offers nothing to authorise', (t) => {
    // It is authorised and unreachable: Authorise is the wrong verb, and
    // Disconnect is the only right one.
    const { sheet } = openMcp(t, oneCell('broken', 'MCP endpoint not found'));
    const sentryCell = cells(sheet)[0];
    assert.ok(sentryCell);
    assert.equal(sentryCell.querySelector('button.ba.fix'), null, 'nothing to authorise');
    assert.equal(actOn(sentryCell)?.textContent, 'Disconnect');
  });

  it('actually disconnects a broken cell — arms, then posts', (t) => {
    // The button existing is not the claim. `paintBody`'s disarm guard once read
    // `state === 'ok'`, so arming a broken cell repainted, cleared `armed` on
    // the spot, and the second press posted nothing: the one verb that applies
    // to a broken server was the one that could not be pressed.
    const { p, sheet } = openMcp(t, oneCell('broken', 'MCP endpoint not found'));
    actOn(cells(sheet)[0])?.click();
    assert.equal(actOn(cells(sheet)[0])?.textContent, 'Disconnect?', 'the arm has to stick');
    actOn(cells(sheet)[0])?.click();
    assert.equal(
      (p.posted.at(-1) as { type: string } | undefined)?.type,
      'mcpLogout',
      'the second press posts'
    );
  });

  it('offers no button at all on a pending cell', (t) => {
    // `claude mcp login` refuses a server awaiting approval, so a button here
    // could only fail. Measured 2026-08-19.
    const { sheet } = openMcp(t, oneCell('pending', 'Run claude in that directory to approve it'));
    const row = cells(sheet)[0];
    assert.ok(row);
    assert.equal(row.querySelector('button'), null, 'neither verb applies');
    assert.match(sheet.textContent ?? '', /Run claude in that directory/);
  });

  it('does not offer to authorise a pending cell', (t) => {
    // The regression this pair exists for: adding a state to the union compiles
    // clean and falls through to Authorise, which cannot work.
    const { sheet } = openMcp(t, oneCell('pending', 'Awaiting approval'));
    assert.doesNotMatch(sheet.textContent ?? '', /Authorise/);
  });
});

describe('mcp servers — the sheet, cut by repo', () => {
  const sections = (sheet: HTMLElement): HTMLElement[] => [
    ...sheet.querySelectorAll<HTMLElement>('.rsec')
  ];
  const named = (sheet: HTMLElement, label: string): HTMLElement => {
    const hit = sections(sheet).find((s) => s.querySelector('.rname')?.textContent === label);
    assert.ok(hit, 'a section for ' + label);
    return hit;
  };
  const open = (section: HTMLElement): boolean => section.classList.contains('open');
  const rowsIn = (section: HTMLElement): HTMLElement[] => [
    ...section.querySelectorAll<HTMLElement>('.srow')
  ];

  /** `linear` reached from two repos, a repo with nothing, and a trailing section. */
  const board = (): Partial<McpView> => ({
    summary: 'All connected',
    groups: [
      group({
        root: '/repos/shop',
        label: 'shop',
        path: '~/repos/shop',
        here: true,
        servers: [
          {
            name: 'linear',
            key: 'https://mcp.linear.app/mcp',
            host: 'mcp.linear.app',
            projects: ['shop', 'acme'],
            scope: 'project',
            scopeLabel: 'project',
            alsoIn: ['acme'],
            brands: [cell('claude', 'ok', { root: '/repos/shop' })]
          }
        ]
      }),
      group({
        root: '/repos/acme',
        label: 'acme',
        path: '~/repos/acme',
        here: false,
        servers: [
          {
            name: 'linear',
            key: 'https://mcp.linear.app/mcp',
            host: 'mcp.linear.app',
            projects: ['shop', 'acme'],
            scope: 'local',
            scopeLabel: 'local',
            alsoIn: ['shop'],
            brands: [cell('claude', 'needs', { root: '/repos/acme' })]
          }
        ]
      }),
      group({
        root: '/repos/empty',
        label: 'empty',
        path: '~/repos/empty',
        here: false,
        emptyLine: 'No MCP server configured. claude mcp add from this repo.',
        servers: []
      }),
      group({
        root: '',
        label: 'Not from a repo',
        path: 'every cwd',
        here: false,
        servers: [
          {
            name: 'slack',
            key: 'https://mcp.slack.com/mcp',
            host: 'mcp.slack.com',
            projects: [],
            brands: [cell('grok', 'ok', { name: 'slack' })]
          }
        ]
      })
    ]
  });

  it("opens this window's repo, first, and leaves the rest shut", (t) => {
    const { sheet } = openMcp(t, board());
    const all = sections(sheet);
    const first = all[0];
    assert.ok(first);
    assert.equal(first.querySelector('.rname')?.textContent, 'shop', 'this window first');
    assert.equal(open(first), true, 'and open');
    assert.deepEqual(all.slice(1).map(open), [false, false, false], 'every other section shut');
  });

  it("says a shut section's worst state and its count without opening it", (t) => {
    // The whole reason a section is worth shutting: it can still answer "is
    // anything in here broken" from its head.
    const { sheet } = openMcp(t, board());
    const acme = named(sheet, 'acme');
    assert.equal(open(acme), false);
    assert.ok(acme.querySelector('.rdot.needs'), 'the dot carries the worst cell');
    assert.equal(acme.querySelector('.rcount')?.textContent, '1');
    assert.ok(named(sheet, 'shop').querySelector('.rdot.ok'), 'all connected reads green');
  });

  it('draws a repo with no servers as its own empty line, not as nothing', (t) => {
    const { sheet } = openMcp(t, board());
    const empty = named(sheet, 'empty');
    assert.equal(empty.querySelector('.rcount')?.textContent, '—');
    assert.ok(empty.querySelector('.rdot.none'), 'no state to report');
    empty.querySelector<HTMLElement>('.rhead')?.click();
    assert.match(empty.textContent ?? '', /claude mcp add/);
  });

  it('draws a url two repos reach in both, each tagged with the other', (t) => {
    const { sheet } = openMcp(t, board());
    const shop = named(sheet, 'shop');
    const acme = named(sheet, 'acme');
    acme.querySelector<HTMLElement>('.rhead')?.click();
    assert.equal(rowsIn(shop).length, 1);
    assert.equal(rowsIn(acme).length, 1);
    assert.match(shop.querySelector('.shrd')?.textContent ?? '', /also in acme/);
    assert.match(acme.querySelector('.shrd')?.textContent ?? '', /also in shop/);
    assert.equal(shop.querySelector('.scope')?.textContent, 'project');
    assert.equal(acme.querySelector('.scope')?.textContent, 'local');
  });

  it("names every repo a shared Disconnect reaches, and posts this section's root", (t) => {
    // One login, keyed by url. Taking it here takes it there too, and the
    // confirm is the only place that can say so.
    const { p, sheet } = openMcp(t, board());
    const act = named(sheet, 'shop').querySelector<HTMLButtonElement>('button.ba.out');
    assert.ok(act);
    act.click();
    const armedSection = named(sheet, 'shop');
    assert.match(armedSection.textContent ?? '', /acme/, 'the other repo is named');
    armedSection.querySelector<HTMLButtonElement>('button.ba.out.arm')?.click();
    assert.deepEqual(lastAction(p), {
      type: 'mcpLogout',
      target: actionRef('claude', 'linear', '/repos/shop')
    });
  });

  it('forces a section open when a login inside it is in flight', (t) => {
    // `overlayLive` synthesises a row whose whole content is a Cancel button.
    // Shut, that button is unreachable and the login looks stuck.
    const view = board();
    const groups = [...(view.groups ?? [])];
    groups[1] = group({
      root: '/repos/acme',
      label: 'acme',
      here: false,
      servers: [
        {
          name: 'linear',
          key: 'https://mcp.linear.app/mcp',
          host: 'mcp.linear.app',
          projects: ['acme'],
          brands: [cell('claude', 'busy', { note: 'Waiting for authorisation…' })]
        }
      ]
    });
    const { sheet } = openMcp(t, { ...view, groups });
    const acme = named(sheet, 'acme');
    assert.equal(open(acme), true, 'busy cannot hide');
    assert.ok(acme.querySelector('button.ba'), 'and Cancel is reachable');
  });

  it('will not let a login in flight be shut away from its Cancel button', (t) => {
    // The head reads as open while pinned, so a press used to take the close
    // branch: nothing moved, and the section collapsed later when the login
    // ended. Disabled says it cannot act instead of acting invisibly.
    const view = board();
    const groups = [...(view.groups ?? [])];
    groups[1] = group({
      root: '/repos/acme',
      label: 'acme',
      here: false,
      servers: [
        {
          name: 'linear',
          key: 'https://mcp.linear.app/mcp',
          host: 'mcp.linear.app',
          projects: ['acme'],
          brands: [cell('claude', 'busy', { note: 'Waiting for authorisation…' })]
        }
      ]
    });
    const { p, sheet } = openMcp(t, { ...view, groups });
    const acme = named(sheet, 'acme');
    assert.equal(open(acme), true);
    const head = acme.querySelector<HTMLButtonElement>('.rhead');
    assert.equal(head?.disabled, true, 'the head cannot be pressed while pinned');
    head?.click();

    // The login ends. The section goes back to its default rather than to
    // whatever that press would have recorded.
    p.push(
      stateMessage([groupView({ sessions: [cardView()] })], {
        accounts: accounts(),
        mcp: mcp(board())
      })
    );
    assert.equal(open(named(sheet, 'acme')), false, 'default, not a stolen shut');
    assert.equal(open(named(sheet, 'shop')), true, "and this window's repo is untouched");
  });

  it('arms one of two rows that share a name and a host at different urls', (t) => {
    // Two worktrees of one repo can carry one name at two urls in their
    // `.mcp.json`, and both remap to the same root — so name-plus-host is not
    // an identity even inside a single section.
    const { p, sheet } = openMcp(t, {
      summary: 'All connected',
      groups: [
        group({
          root: '/repos/shop',
          label: 'shop',
          servers: [
            {
              name: 'linear',
              key: 'https://mcp.linear.app/mcp',
              host: 'mcp.linear.app',
              projects: ['shop'],
              brands: [cell('claude', 'ok', { root: '/repos/shop' })]
            },
            {
              name: 'linear',
              key: 'https://mcp.linear.app/sse',
              host: 'mcp.linear.app',
              projects: ['shop'],
              brands: [cell('claude', 'ok', { root: '/repos/shop' })]
            }
          ]
        })
      ]
    });
    const buttons = [...sheet.querySelectorAll<HTMLButtonElement>('button.ba.out')];
    assert.equal(buttons.length, 2);
    buttons[0]?.click();
    const after = [...sheet.querySelectorAll<HTMLButtonElement>('button.ba.out')];
    assert.equal(after[0]?.textContent, 'Disconnect?');
    assert.equal(after[1]?.textContent, 'Disconnect', 'the other row is not armed with it');
    assert.equal(p.posted.filter((m) => (m as { type: string }).type === 'mcpLogout').length, 0);
  });

  it('keeps a section the reader opened open across a state push', (t) => {
    const { p, sheet } = openMcp(t, board());
    named(sheet, 'acme').querySelector<HTMLElement>('.rhead')?.click();
    assert.equal(open(named(sheet, 'acme')), true);
    p.push(
      stateMessage([groupView({ sessions: [cardView()] })], {
        accounts: accounts(),
        mcp: mcp(board())
      })
    );
    assert.equal(open(named(sheet, 'acme')), true, 'a repaint is not a close');
    assert.equal(open(named(sheet, 'empty')), false, 'and not an open either');
  });
});

/**
 * Codex reports credentials, not reachability. `codex mcp list --json` answers
 * with an `auth_status` and says nothing about whether the server is up, so
 * these are all about one question: does the cell claim only what was read?
 *
 * Contract: `docs/reference/cli_state/codex/mcp.md`.
 */
describe('mcp servers — Codex', () => {
  /** One Codex row in this window's repo, as the fold hands it over. */
  const codexRow = (over: Partial<McpServerView> = {}, cellOver: Partial<McpBrandCell> = {}) => ({
    name: 'linear',
    key: 'https://mcp.linear.app/mcp',
    host: 'mcp.linear.app',
    projects: ['acme-web'],
    ...over,
    brands: [cell('codex', cellOver.state ?? 'ok', { root: '/repos/acme-web', ...cellOver })]
  });

  it('says a status it never read was not checked, and offers nothing', (t) => {
    const { sheet } = openMcp(t, {
      summary: 'Status not checked',
      summaryWants: false,
      servers: [codexRow({}, { state: 'unknown', canDisconnect: false })]
    });
    const box = cells(sheet)[0];
    assert.ok(box);
    assert.match(box.textContent ?? '', /Not checked/);
    assert.doesNotMatch(box.textContent ?? '', /Connected/, 'configured is not connected');
    assert.equal(actOn(box), null, 'nothing to press on a reading we never took');
  });

  it('posts startMcpLogin for Codex with the cell root', (t) => {
    const { p, sheet } = openMcp(t, {
      servers: [codexRow({}, { state: 'needs', canDisconnect: false })]
    });
    actOn(cells(sheet)[0])?.click();
    assert.deepEqual(lastAction(p), {
      type: 'startMcpLogin',
      target: actionRef('codex', 'linear', '/repos/acme-web')
    });
  });

  it('arms and posts Codex logout for a stored OAuth grant', (t) => {
    const { p, sheet } = openMcp(t, {
      servers: [codexRow({}, { state: 'ok', canDisconnect: true })]
    });
    assert.equal(actOn(cells(sheet)[0])?.textContent, 'Disconnect');
    actOn(cells(sheet)[0])?.click();
    actOn(cells(sheet)[0])?.click();
    assert.deepEqual(lastAction(p), {
      type: 'mcpLogout',
      target: actionRef('codex', 'linear', '/repos/acme-web')
    });
  });

  it('gives a connected bearer-token cell no credential button', (t) => {
    const { sheet } = openMcp(t, {
      summary: 'All connected',
      servers: [codexRow({}, { state: 'ok', canDisconnect: false })]
    });
    const box = cells(sheet)[0];
    assert.ok(box);
    assert.match(box.textContent ?? '', /Connected/);
    // The token is configured, not stored by us. There is nothing to take back,
    // and Authorise would restart a login that already succeeded.
    assert.equal(actOn(box), null);
  });

  it('draws a STDIO server without a url, and never its arguments', (t) => {
    const { sheet } = openMcp(t, {
      summary: 'All connected',
      servers: [
        codexRow(
          { name: 'pencil', key: 'codex|user||pencil', host: 'STDIO · mcp-server-darwin-arm64' },
          { name: 'pencil', state: 'ok', canDisconnect: false }
        )
      ]
    });
    const row = sheet.querySelector('.srow');
    assert.ok(row);
    assert.match(row.textContent ?? '', /STDIO/);
    assert.match(row.textContent ?? '', /mcp-server-darwin-arm64/);
    assert.doesNotMatch(row.textContent ?? '', /--app|desktop/, 'arguments never painted');
    assert.equal(actOn(cells(sheet)[0]), null, 'a process has no credential');
  });

  it('says why a disabled server is not running', (t) => {
    const { sheet } = openMcp(t, {
      servers: [
        codexRow({}, { state: 'unknown', canDisconnect: false, note: 'Disabled in config.toml' })
      ]
    });
    assert.match(sheet.textContent ?? '', /Disabled in config\.toml/);
  });

  it('leaves a section of only unknown cells cool', (t) => {
    const { sheet } = openMcp(t, {
      groups: [
        group({
          servers: [codexRow({}, { state: 'unknown', canDisconnect: false })]
        })
      ]
    });
    const dot = sheet.querySelector('.rsec .rdot');
    assert.ok(dot);
    assert.equal(dot.classList.contains('needs'), false, 'nothing here is the fix');
  });
});

describe('MCP declaration intent', () => {
  for (const state of ['needs', 'ok'] as const) {
    it(`posts the selected declaration for ${state === 'needs' ? 'authorise' : 'disconnect'}`, (t) => {
      const root = path.resolve('/repo/b');
      const nested = path.join(root, 'nested');
      const target: McpActionRef = {
        brand: 'grok',
        name: 'same',
        key: 'https://b.example/mcp',
        url: 'https://b.example/mcp',
        declaration: { scope: 'project', root: nested },
        readCwd: nested
      };
      const { p, sheet } = openMcp(t, {
        servers: [
          {
            name: 'same',
            key: target.key,
            host: 'b.example',
            projects: ['b'],
            brands: [cell('grok', state, { name: 'same', root, target })]
          }
        ]
      });
      actOn(cells(sheet)[0])?.click();
      if (state === 'ok') actOn(cells(sheet)[0])?.click();
      assert.deepEqual(lastAction(p), {
        type: state === 'needs' ? 'startMcpLogin' : 'mcpLogout',
        target
      });
    });
  }
});

describe('MCP click feedback', () => {
  for (const changed of [false, true]) {
    it(`retains heading focus after a toggle and ${changed ? 'changed' : 'unchanged'} push`, (t) => {
      const { p, sheet } = openMcp(t);
      const head = sheet.querySelector<HTMLButtonElement>('.rhead');
      assert.ok(head);
      head.focus();
      head.click();
      p.push(
        stateMessage([], {
          accounts: accounts(),
          mcp: mcp(changed ? { hint: 'Fresh configuration' } : {})
        })
      );
      const after = sheet.querySelector<HTMLButtonElement>('.rhead');
      assert.equal(p.window.document.activeElement, after);
      if (!changed) assert.equal(after, head, 'unchanged push keeps the toggle node');
    });
  }

  it('shows a refusal even when its declaration disappeared from the returned view', (t) => {
    const { p, sheet } = openMcp(t);
    sheet.querySelector<HTMLButtonElement>('button.ba.fix')?.click();
    const operationId = lastRequest(p);
    p.push({
      type: 'mcpActionProgress',
      operationId,
      phase: 'error',
      message: 'Declaration changed. Reopen MCP.',
      mcp: mcp({ servers: [] })
    });
    assert.match(sheet.textContent ?? '', /Declaration changed/);
  });

  const lastRequest = (p: ReturnType<typeof openPanel>): string => {
    const request = p.posted.at(-1) as { operationId?: string };
    assert.equal(typeof request.operationId, 'string', 'each click has a reply address');
    assert.ok(request.operationId);
    return request.operationId;
  };

  for (const state of ['needs', 'error'] as const) {
    it(`shows immediate pending for ${state}, survives pushes and ignores stale replies`, (t) => {
      const view = mcp({
        servers: [
          {
            name: 'notion',
            key: 'notion',
            host: 'mcp.notion.com',
            projects: [],
            brands: [cell('claude', state, { name: 'notion' })]
          }
        ]
      });
      const { p, sheet } = openMcp(t, view);
      const action = actOn(cells(sheet)[0]);
      action?.focus();
      action?.click();
      const operationId = lastRequest(p);
      assert.match(cells(sheet)[0]?.textContent ?? '', /Starting/);
      assert.equal(cells(sheet)[0]?.getAttribute('aria-busy'), 'true');
      const count = p.posted.length;
      action?.click();
      assert.equal(p.posted.length, count, 'even the detached original button cannot resubmit');
      p.push(
        stateMessage([], { accounts: accounts(), mcp: { ...view, hint: 'Unrelated refresh' } })
      );
      assert.equal(cells(sheet)[0]?.getAttribute('aria-busy'), 'true');
      p.push({ type: 'mcpActionProgress', operationId: 'earlier-click', phase: 'done', mcp: view });
      assert.equal(cells(sheet)[0]?.getAttribute('aria-busy'), 'true');
      assert.equal(
        p.window.document.activeElement,
        actOn(cells(sheet)[0]),
        'focus follows progress'
      );
      p.push({
        type: 'mcpActionProgress',
        operationId,
        phase: 'error',
        message: 'Preparation refused',
        mcp: view
      });
      assert.notEqual(cells(sheet)[0]?.getAttribute('aria-busy'), 'true');
      assert.match(sheet.textContent ?? '', /Preparation refused/);
      assert.equal(actOn(cells(sheet)[0])?.textContent, 'Retry');
      actOn(cells(sheet)[0])?.click();
      assert.notEqual(lastRequest(p), operationId, 'retry has a new identity');
      assert.equal(cells(sheet)[0]?.getAttribute('aria-busy'), 'true');
    });
  }

  it('holds confirmed Disconnect through refreshes and settles with the returned state', (t) => {
    const { p, sheet } = openMcp(t);
    actOn(cells(sheet)[0])?.click();
    assert.equal(cells(sheet)[0]?.getAttribute('aria-busy'), null, 'first click only confirms');
    actOn(cells(sheet)[0])?.click();
    const operationId = lastRequest(p);
    assert.match(cells(sheet)[0]?.textContent ?? '', /Disconnecting/);
    assert.equal(actOn(cells(sheet)[0])?.disabled, true);
    p.push(stateMessage([], { accounts: accounts(), mcp: mcp({ hint: 'Still checking' }) }));
    assert.equal(cells(sheet)[0]?.getAttribute('aria-busy'), 'true');
    const result = mcp({
      servers: [
        {
          name: 'linear',
          key: 'https://mcp.linear.app/mcp',
          host: 'mcp.linear.app',
          projects: [],
          brands: [cell('claude', 'needs')]
        }
      ]
    });
    p.push({ type: 'mcpActionProgress', operationId, phase: 'done', mcp: result });
    assert.equal(actOn(cells(sheet)[0])?.textContent, 'Authorise');
    assert.notEqual(cells(sheet)[0]?.getAttribute('aria-busy'), 'true');
  });

  it('cancels during preparation and ignores its late outcome after a new click', (t) => {
    const { p, sheet } = openMcp(t);
    const authorise = () => sheet.querySelector<HTMLButtonElement>('button.ba.fix');
    authorise()?.click();
    const operationId = lastRequest(p);
    const cancel = [...sheet.querySelectorAll<HTMLButtonElement>('button.ba')].find(
      (b) => b.textContent === 'Cancel'
    );
    assert.ok(cancel, 'preparation can be cancelled immediately');
    cancel.click();
    assert.deepEqual(p.posted.at(-1), { type: 'cancelMcpLogin', operationId });
    assert.match(sheet.textContent ?? '', /Cancelling/);
    p.push({ type: 'mcpActionProgress', operationId, phase: 'cancelled', mcp: mcp() });
    authorise()?.click();
    const next = lastRequest(p);
    p.push({ type: 'mcpActionProgress', operationId, phase: 'error', message: 'Old error' });
    assert.doesNotMatch(sheet.textContent ?? '', /Old error/);
    assert.equal(lastRequest(p), next);
    assert.match(sheet.textContent ?? '', /Starting/);
  });

  it('keeps a disconnect pending across close/reopen and accepts only its own outcome', (t) => {
    const { p, sheet } = openMcp(t);
    actOn(cells(sheet)[0])?.click();
    actOn(cells(sheet)[0])?.click();
    const operationId = lastRequest(p);
    sheet.querySelector<HTMLButtonElement>('.ax')?.click();
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    p.window.document.querySelector<HTMLElement>('.mcpfoot')?.click();
    assert.match(sheet.textContent ?? '', /Disconnecting/);
    p.push({
      type: 'mcpActionProgress',
      operationId,
      phase: 'error',
      message: 'Logout refused',
      mcp: mcp()
    });
    assert.match(sheet.textContent ?? '', /Logout refused/);
    assert.equal(actOn(cells(sheet)[0])?.textContent, 'Disconnect');
  });
});
