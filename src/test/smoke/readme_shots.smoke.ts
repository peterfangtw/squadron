import { ticketPriority, ticketState, ticketSourceView } from '../ticket_fixtures';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as boot from './boot';
import * as fixtures from '../harness';
import { warmConfig } from '../../core/cache_ttl';
import type { RemoteView } from '../../core/remote/link';
import * as manifest from '../../core/slack/manifest';
import { slackEntry } from '../../core/slack/messenger';
import { DEFAULT_WARM_POLICY } from '../../core/warm_policy';
import { remoteStateView } from '../../ui/remote_view';

/**
 * The README's screenshots, retaken in one command:
 *
 *   npm run test:smoke:one -- out/test/smoke/readme_shots.smoke.js
 *
 * Not a test, and not in the barrel. It boots the stock host as every smoke
 * file does, opens the real panel and pushes made-up state into it — the real
 * document, stylesheet and script painting sessions that do not exist — then
 * screenshots the panel's frame. `SQUADRON_SHOTS` names the folder the PNGs go
 * to; unset, they overwrite `media/`. Remote's words come from the real mapper
 * over Slack's real setup entry, and Warm's figures from the real defaults.
 *
 * Every frame is the panel at 1500x820 CSS px and device scale 2, so 3000x1640,
 * in the `lift` theme over the host's default dark greys. A laptop display has
 * no room for a window that size, so the workbench page's metrics are emulated
 * over CDP instead; the pin `boot.ts` holds is a ruler for the nav ladder and
 * this file asks nothing of it.
 */

const REPO = path.join(__dirname, '..', '..', '..');
const OUT = process.env['SQUADRON_SHOTS'] ?? path.join(REPO, 'media');
const FRAME = { width: 1500, height: 820 };
const CODE = '/Users/maya/code';
const WEB = CODE + '/larkspur-web';
const API = CODE + '/larkspur-api';
const MINUTE = 60_000;

boot.section(
  'README screenshots',
  () => {
    boot.step('hero: two folders, the alert bar, Warm, the chick and a conversation', async () => {
      await frame();
      const now = Date.now();
      const groups = boardGroups(now);
      const thread = fixtures.threadView({ ...savedCards(now), exchanges: savedCardsTalk(now) });
      await shoot('screenshot.png', async () => {
        await open(state(now, groups, { mascot: true }), thread);
        await push(state(now, groups, { thread, mascot: true }));
        await dockWidth(540);
        await settle(3000);
      });
    });

    boot.step('collab: Claude hands a build to Codex and a review to Grok', async () => {
      const now = Date.now();
      const groups = collabGroups(now);
      const thread = fixtures.threadView({
        ...collabCards(now)[0]!,
        exchanges: collabTalk(now)
      });
      await shoot('screenshot-collab.png', async () => {
        await open(state(now, groups), thread);
        await push(state(now, groups, { thread }));
        await dockWidth(640);
        await settle(2500);
      });
    });

    boot.step('tickets: status columns beside a conversation', async () => {
      await frame();
      const now = Date.now();
      const groups = boardGroups(now, { quiet: true });
      const tickets = { tickets: backlog(), ticketSource: linear() };
      const thread = fixtures.threadView({ ...savedCards(now), exchanges: savedCardsTalk(now) });
      await shoot('screenshot-tickets.png', async () => {
        await open(state(now, groups, tickets), thread);
        await push(state(now, groups, { ...tickets, thread }));
        await boot.panel().locator('[data-act="tickets"]').click();
        await dockWidth(560);
        await boot.panel().locator('#tk-list .tk').first().waitFor();
        await settle(800);
      });
    });

    boot.step('Remote: the sheet, live on Slack', async () => {
      const now = Date.now();
      const groups = boardGroups(now);
      const thread = fixtures.threadView({ ...savedCards(now), exchanges: savedCardsTalk(now) });
      await shoot('screenshot-remote.png', async () => {
        await open(state(now, groups, { remote: remote(now) }), thread);
        await push(state(now, groups, { thread, remote: remote(now) }));
        await dockWidth(520);
        await boot.panel().locator('#bottomhub .remote-tab').click();
        await boot.panel().locator('#bottomdrawer.remote:not([hidden])').waitFor();
        await settle(2500);
      });
      await boot.ctx.page.keyboard.press('Escape');
    });

    boot.step('Warm: the sheet, per-CLI lifetimes and warmed cards', async () => {
      const now = Date.now();
      const groups = warmGroups(now);
      const thread = fixtures.threadView({ ...savedCards(now), exchanges: savedCardsTalk(now) });
      await shoot('screenshot-warm.png', async () => {
        await open(state(now, groups, { warmCache: true }), thread);
        await push(state(now, groups, { thread, warmCache: true }));
        await dockWidth(520);
        await boot.panel().locator('#bottomhub .warm-tab').click();
        await boot.panel().locator('#bottomdrawer.warm:not([hidden])').waitFor();
        await settle(2500);
      });
      await boot.ctx.page.keyboard.press('Escape');
    });
  },
  () => ({ 'workbench.colorTheme': 'Default Dark Modern' })
);

// ---- the sessions -----------------------------------------------------------

type CardOver = Parameters<typeof fixtures.cardView>[0];

/** A card of this team's: owned, as every card on a real board is. */
const card = (over: CardOver): CardView => fixtures.cardView({ owned: true, ...over });

function savedCards(now: number): CardView {
  return card({
    pid: 701,
    name: 'Saved cards at checkout',
    fullCwd: WEB,
    status: 'busy',
    brand: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    contextSize: 1_000_000,
    contextPct: 14,
    branch: 'feat/saved-cards',
    startedAt: now - 40 * MINUTE,
    updatedAt: now - 4_000
  });
}

/** The board most scenes stand on: two folders, every state a card can be in. */
function boardGroups(now: number, { quiet = false, warmed = false } = {}): GroupView[] {
  /** Warm on, `last` minutes after the session's last real turn. */
  const warm = (ttl: number, last: number): CardOver =>
    warmed
      ? {
          warm: {
            on: true,
            ttlMs: ttl * MINUTE,
            source: 'measured',
            nextAt: now - last * MINUTE + (ttl - 5) * MINUTE
          },
          updatedAt: now - last * MINUTE
        }
      : {};
  const web = [
    savedCards(now),
    card({
      pid: 702,
      name: 'Empty state for the trips list',
      fullCwd: WEB,
      status: warmed ? 'idle' : quiet ? 'busy' : 'waiting',
      brand: 'grok',
      model: 'grok-4.7',
      effort: 'high',
      contextSize: 500_000,
      contextPct: 6,
      branch: 'feat/trips-empty',
      startedAt: now - 25 * MINUTE,
      updatedAt: now - 70_000,
      ...warm(15, 6)
    }),
    card({
      pid: 703,
      name: 'Fix flaky booking test',
      fullCwd: WEB,
      status: 'idle',
      brand: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      contextSize: 272_000,
      contextPct: 31,
      branch: 'fix/booking-flake',
      unseen: true,
      turnOutcome: 'done',
      startedAt: now - 55 * MINUTE,
      updatedAt: now - 22_000,
      ...warm(30, 11)
    })
  ];
  const api = [
    card({
      pid: 704,
      name: 'Rate limit the login route',
      fullCwd: API,
      status: 'idle',
      brand: 'claude',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      contextSize: 200_000,
      contextPct: 38,
      branch: 'feat/login-limit',
      warm: { on: true, ttlMs: 60 * MINUTE, source: 'measured', nextAt: now + 31 * MINUTE },
      ...(quiet ? {} : { warming: true as const }),
      startedAt: now - 90 * MINUTE,
      updatedAt: now - 24 * MINUTE
    }),
    card({
      pid: 705,
      name: 'Migration for user roles',
      fullCwd: API,
      status: 'busy',
      brand: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      contextSize: 272_000,
      contextPct: 52,
      branch: 'feat/roles',
      startedAt: now - 18 * MINUTE,
      updatedAt: now - 7_000
    })
  ];
  return [group('larkspur-web', WEB, web), group('larkspur-api', API, api)];
}

function group(label: string, cwd: string, sessions: CardView[], over = {}): GroupView {
  return fixtures.groupView({ label, app: '~/code', cwd, sessions, ...over });
}

function savedCardsTalk(now: number): ExchangeView[] {
  return [
    you(
      now - 6 * MINUTE,
      'Let travellers save a card at checkout and pick it next time. Reuse the Stripe customer we already create, and keep the card form as the fallback.'
    ),
    {
      role: 'assistant',
      at: now - 5 * MINUTE,
      text: '',
      blocks: [
        html(
          'I’ll look at how checkout talks to Stripe today, then add saved cards behind the customer it already has.'
        ),
        { summary: 'Read file', detail: 'src/checkout/PaymentStep.tsx' },
        { summary: 'Ran command', detail: 'rg -n "customer" src/payments' },
        html(
          'The customer is created in <code>ensureCustomer()</code> on the first booking, so a saved card only needs a <code>SetupIntent</code> against it. I’ll list cards with <code>useSavedCards()</code> and keep <code>CardForm</code> for a new one.'
        ),
        { summary: 'Edited', detail: 'src/payments/savedCards.ts' },
        { summary: 'Edited', detail: 'src/checkout/PaymentStep.tsx' },
        { summary: 'Ran command', detail: 'npm test -- checkout' },
        html('Tests pass. Checking the expired-card case before I hand it back.')
      ]
    }
  ];
}

// ---- collab -----------------------------------------------------------------

const CODEX_ID = '7c4a91e2-5b0d-4f3e-9a61-2d8e0c7b4f15';
const GROK_ID = 'f02b6d3a-91c4-4e7f-b8a2-5e1d9c3f7a40';

function collabCards(now: number): CardView[] {
  return [
    card({
      pid: 801,
      name: 'Shareable trip links',
      fullCwd: WEB,
      status: 'busy',
      brand: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
      contextSize: 1_000_000,
      contextPct: 9,
      branch: 'main',
      children: [802, 803],
      startedAt: now - 30 * MINUTE,
      updatedAt: now - 4_000
    }),
    card({
      pid: 802,
      name: 'Build trip links',
      fullCwd: WEB,
      status: 'busy',
      brand: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      contextSize: 272_000,
      contextPct: 38,
      branch: 'feat/trip-links',
      parent: 801,
      startedAt: now - 28 * MINUTE,
      updatedAt: now - 5_000
    }),
    card({
      pid: 803,
      name: 'Review trip links',
      fullCwd: WEB,
      status: 'idle',
      brand: 'grok',
      model: 'grok-4.7',
      effort: 'high',
      contextSize: 500_000,
      contextPct: 7,
      branch: 'feat/trip-links',
      parent: 801,
      unseen: true,
      turnOutcome: 'done',
      startedAt: now - 12 * MINUTE,
      updatedAt: now - 60_000
    })
  ];
}

function collabGroups(now: number): GroupView[] {
  return [
    group('larkspur-web', WEB, collabCards(now), {
      families: [{ parent: 801, members: [801, 802, 803] }]
    }),
    group('larkspur-api', API, [
      card({
        pid: 804,
        name: 'Rate limit the login route',
        fullCwd: API,
        status: 'idle',
        brand: 'claude',
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        contextSize: 200_000,
        contextPct: 38,
        branch: 'feat/login-limit',
        startedAt: now - 90 * MINUTE,
        updatedAt: now - 31 * MINUTE
      })
    ])
  ];
}

function collabTalk(now: number): ExchangeView[] {
  return [
    you(
      now - 30 * MINUTE,
      'Add shareable trip links from `docs/trip-sharing.md`. Have Codex build it and Grok review it before you report back.'
    ),
    {
      role: 'assistant',
      at: now - 29 * MINUTE,
      text: '',
      blocks: [
        html('I’ll split it: Codex builds the links, Grok reviews the diff once it lands.'),
        { summary: 'Read file', detail: 'docs/trip-sharing.md' },
        {
          summary: 'Ran command',
          detail: 'squadron-spawn --brand codex --name "Build trip links"'
        },
        {
          summary: 'Ran command',
          detail: 'squadron-spawn --brand grok --name "Review trip links"'
        },
        { summary: 'Ran command', detail: 'squadron-wait --pids 802' }
      ]
    },
    peer(
      now - 14 * MINUTE,
      CODEX_ID,
      'Trip links are done on `feat/trip-links`: a signed share token, a read-only trip page, and 11 new tests passing.'
    ),
    {
      role: 'assistant',
      at: now - 13 * MINUTE,
      text: '',
      blocks: [
        html('Sending the diff to Grok for review.'),
        {
          summary: 'Ran command',
          detail:
            'squadron-send --pid 803 --text "Review feat/trip-links against docs/trip-sharing.md"'
        }
      ]
    },
    peer(
      now - 2 * MINUTE,
      GROK_ID,
      'Two issues: the share token never expires, and the trip page renders traveller emails into the HTML. The rest looks good.'
    ),
    {
      role: 'assistant',
      at: now - 90_000,
      text: '',
      blocks: [
        html('Both are real. Passing them back to Codex, then I’ll ask Grok for one more look.'),
        {
          summary: 'Ran command',
          detail:
            'squadron-send --pid 802 --text "Fix: expire share tokens after 7 days; drop emails from the trip page"'
        }
      ]
    }
  ];
}

// ---- tickets ----------------------------------------------------------------

function backlog(): TicketView[] {
  const ticket = (
    n: number,
    title: string,
    priority: number,
    priorityName: string,
    started = false
  ): TicketView => ({
    scopeId: 'team-a',
    key: 'lsp-' + n,
    identifier: 'LSP-' + n,
    title,
    priority: { ...ticketPriority(priority), label: priorityName },

    state: ticketState(started ? 'In Progress' : 'Todo'),
    url: 'https://linear.app/larkspur/issue/LSP-' + n
  });
  return [
    ticket(218, 'Saved cards: let travellers remove an expired card', 2, 'High'),
    ticket(221, 'Booking history loads every booking at once', 2, 'High'),
    ticket(209, 'Password reset links expire too early', 1, 'Urgent'),
    ticket(224, 'Empty state for the saved addresses list', 3, 'Medium'),
    ticket(197, 'Empty state for the trips list', 3, 'Medium', true),
    ticket(203, 'Flaky booking test on CI', 2, 'High', true),
    ticket(188, 'Rate limit the login route', 4, 'Low', true)
  ];
}

function linear(): TicketSourceStatus {
  return {
    ...ticketSourceView(),
    linked: true,
    filter: { assignee: 'me', states: [], priorities: [] },
    options: {
      scopeId: 'team-a',
      viewerId: 'u-maya',
      assignees: [
        { id: 'u-maya', label: 'Maya' },
        { id: 'u-sam', label: 'Sam' },
        { id: 'unassigned', label: 'Unassigned' }
      ],
      states: [ticketState('Todo'), ticketState('In Progress')],
      priorities: [
        { ...ticketPriority(1), label: 'Urgent' },
        { ...ticketPriority(2), label: 'High' },
        { ...ticketPriority(3), label: 'Medium' },
        { ...ticketPriority(4), label: 'Low' }
      ]
    }
  };
}

// ---- Warm -------------------------------------------------------------------

/** The board with Warm on for one session of each CLI, timed off its last turn. */
function warmGroups(now: number): GroupView[] {
  return boardGroups(now, { quiet: true, warmed: true });
}

// ---- Remote -----------------------------------------------------------------

/** Remote live on Slack in this window, as `RemoteHost.view()` would have it,
 *  through the mapper the host draws with. */
function remote(now: number): RemoteStateView {
  const team = 'T02LRKSPR';
  const view: RemoteView = {
    state: { kind: 'connected', since: now - 3 * 60 * MINUTE },
    setup: {
      messenger: { id: slackEntry.id, label: slackEntry.label },
      fields: slackEntry.setup.fields.map((field) => ({
        key: field.key,
        label: field.label,
        set: true
      })),
      allowlist: ['U04MAYA7QX'],
      space: { value: team }
    },
    awake: 'drinking',
    check: {
      kind: 'result',
      at: now - 3 * 60 * MINUTE,
      result: {
        kind: 'ok',
        space: team,
        facts: [
          { label: 'Workspace', value: 'Larkspur' },
          { label: 'Bot', value: '@squadron' },
          { label: 'Scopes', value: 'checked' },
          ...manifest.OPTIONAL_SCOPES.map(({ feature }) => ({
            label: feature,
            value: 'available'
          }))
        ]
      }
    }
  };
  return remoteStateView(view, slackEntry.setup);
}

// ---- the state around them --------------------------------------------------

function state(
  now: number,
  groups: GroupView[],
  over: Partial<Omit<StateMessage, 'type' | 'groups'>> = {}
): StateMessage {
  return fixtures.stateMessage(groups, {
    theme: 'lift',
    cafe: true,
    cafeRemote: true,
    orchestrators: true,
    warmConfig: warmConfig(DEFAULT_WARM_POLICY),
    machine: { cpu: 31, memory: { used: 16.2 * 2 ** 30, total: 32 * 2 ** 30 } },
    awake: { reason: 'drinking', until: now + 42 * MINUTE, sessions: 2 },
    accounts: accounts(now),
    models: [
      fixtures.modelView(),
      fixtures.modelView({
        value: 'claude-sonnet-5-5',
        id: 'claude-sonnet-5-5',
        name: 'Sonnet 5.5',
        window: 200_000
      }),
      fixtures.modelView({
        value: 'gpt-6.1-sol',
        id: 'gpt-6.1-sol',
        name: 'Sol 6.1',
        brand: 'codex',
        brandLabel: 'Codex',
        window: 272_000
      }),
      fixtures.modelView({
        value: 'grok-4.7',
        id: 'grok-4.7',
        name: 'Grok 4.7',
        brand: 'grok',
        brandLabel: 'Grok',
        window: 500_000
      })
    ],
    workflows: [
      fixtures.workflowView(),
      fixtures.workflowView({ id: 'review', label: 'Peer review' })
    ],
    ...over
  });
}

function accounts(now: number): AccountView[] {
  const usage = (five: number, week: number): UsageView => ({
    at: now - MINUTE,
    windows: [
      { id: 'five_hour', short: '5h', pct: five, resetsAt: now + 2 * 60 * MINUTE },
      { id: 'seven_day', short: 'wk', pct: week, resetsAt: now + 3 * 24 * 60 * MINUTE }
    ]
  });
  const signedIn = (brand: BrandId, name: string, use: UsageView): AccountView => ({
    brand,
    name,
    mark: brand,
    state: 'signed_in',
    label: 'maya@larkspur.travel',
    detail: name,
    usage: use
  });
  return [
    signedIn('claude', 'Claude', usage(18, 41)),
    signedIn('codex', 'Codex', usage(9, 22)),
    signedIn('grok', 'Grok', usage(4, 12))
  ];
}

const you = (at: number, prose: string): ExchangeView => ({
  role: 'user',
  at,
  text: prose,
  blocks: [{ prose }]
});

const peer = (at: number, from: string, prose: string): ExchangeView => ({
  role: 'user',
  at,
  from,
  text: prose,
  blocks: [{ prose }]
});

/** What the host's markdown engine hands the dock for one paragraph. */
const html = (inner: string): BlockView => ({ html: '<p>' + inner + '</p>' });

// ---- driving the panel ------------------------------------------------------

/** The panel's frame at `FRAME`, at device scale 2, whatever the window is. */
async function frame(): Promise<void> {
  await boot.openPanel();
  const page = boot.ctx.page;
  const cdp = await page.context().newCDPSession(page);
  const webview = page.locator('iframe.webview.ready').last();
  let width = FRAME.width + 400;
  let height = FRAME.height + 200;
  for (let tries = 0; tries < 6; tries++) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false
    });
    await page.waitForTimeout(400);
    const box = await webview.boundingBox();
    if (!box) throw new Error('the panel has no box');
    if (Math.round(box.width) === FRAME.width && Math.round(box.height) === FRAME.height) return;
    width += FRAME.width - Math.round(box.width);
    height += FRAME.height - Math.round(box.height);
  }
  throw new Error('the panel would not take the frame size');
}

/** Push made-up state, as the host's own push arrives. */
async function push(message: StateMessage): Promise<void> {
  await boot
    .panel()
    .locator('body')
    .evaluate((_, data) => {
      window.dispatchEvent(new MessageEvent('message', { data }));
    }, message);
}

/** The board, then the press that makes `thread`'s card the dock's selection.
 *  Its thread is the caller's next push. */
async function open(board: StateMessage, thread: ThreadView): Promise<void> {
  await boot.panel().locator('#board-sessions').click();
  await push(board);
  await boot.panel().locator(`.card[data-pid="${thread.pid}"]`).click();
  // Onto empty board, so the card name's hover tip is not in the frame: the
  // tip hides on a `mouseout` inside the panel, which a pointer leaving the
  // frame never sends.
  const cards = await boot.panel().locator('#cards').boundingBox();
  if (cards) await boot.ctx.page.mouse.move(cards.x + 8, cards.y + cards.height - 8);
}

/** The dock's divider, dragged to `px` wide the way a reader drags it. */
async function dockWidth(px: number): Promise<void> {
  await boot
    .panel()
    .locator('body')
    .evaluate((_, width) => {
      const divider = document.getElementById('divider')!;
      const x = window.innerWidth - width;
      divider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x + 4 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x }));
    }, px);
}

async function settle(ms: number): Promise<void> {
  await boot.ctx.page.waitForTimeout(ms);
}

/** Arrange a scene with the host's pushes held off it, then shoot the frame. */
async function shoot(name: string, arrange: () => Promise<void>): Promise<void> {
  await fs.mkdir(OUT, { recursive: true });
  await boot.holdingHostState(async () => {
    await arrange();
    await boot.ctx.page
      .locator('iframe.webview.ready')
      .last()
      .screenshot({ path: path.join(OUT, name), animations: 'allow' });
  });
}
