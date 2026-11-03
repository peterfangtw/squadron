import * as vscode from 'vscode';
import type { Session } from '../core/model';
import {
  accountRow,
  accountRows,
  accountSessionCounts,
  completeAccountPoll,
  type AccountRowStatus,
  type LoginEvent,
  type LoginSession
} from '../core/accounts';
import { claudeAuthLogout, startClaudeLogin } from '../core/claude/auth';
import { grokAuthLogout, startGrokLogin } from '../core/grok/auth';
import { codexAuthLogout, startCodexLogin } from '../core/codex/auth';
import { refreshCatalog, signInFor } from '../core/signin';
import { adapter, type BrandAvailability } from '../core/adapter';
import { BRANDS } from '../core/brands';
import { webUri } from '../core/web';
import { forgetUsageFor, pendingUsageWindows, usageFor } from '../core/usage';
import {
  McpHealth,
  readClaudeMcp,
  mcpLogout,
  recheckMcpHealth,
  prepareMcpLogin as prepareMcpLoginChild
} from '../core/claude/mcp';
import {
  GROK_MCP_WAIT,
  readGrokMcp,
  grokMcpLogout,
  prepareGrokMcpLogin as prepareGrokMcpLoginChild
} from '../core/grok/mcp';
import {
  codexMcpLogout,
  readCodexMcp,
  prepareCodexMcpLogin as prepareCodexMcpLoginChild
} from '../core/codex/mcp';
import { resolveMcpTarget, type McpActionTarget } from '../core/mcp_target';
import { foldBoard, foldMcpView, healthRoots } from '../core/mcp';
import type {
  McpBoard,
  McpLoginPrepared,
  McpLoginLive,
  McpLoginPhase,
  McpLoginSession,
  McpRepo,
  McpRow,
  McpSnapshot
} from '../core/mcp';
import type { BrandId, RateLimits } from '../core/model';
import { PanelActions } from './panel_actions';
import { configuredPath } from './cli_path';

/** Private panel auth state. Other `PanelActions` verbs cannot write MCP health. */
export type AuthState = {
  /** One entry per brand that has answered. Absent is not signed out. */
  accounts: Partial<Record<BrandId, AccountRowStatus>>;
  /** First poll of each brand has been attempted — accounts stay off until all. */
  authTried: Partial<Record<BrandId, boolean>>;
  /** Which brands a binary was found for, re-read every pass. A brand
   *  missing from this is one nothing has looked for yet, which `offeredModels`
   *  keeps rather than drops. */
  installed: Partial<Record<BrandId, boolean>>;
  authGen: number;
  login?: LoginSession;
  /**
   * Bumped on every cancel / replace so a killed child's trailing stdout and
   * non-zero `close` cannot repost `loginProgress` and re-open the sheet the
   * reader already dismissed.
   */
  loginGen: number;
  /**
   * The last MCP declarations and the board scope needed to retake the reading.
   * Action references retain their original cwd independently of repo grouping.
   */
  mcp?: {
    rows: McpRow[];
    roots: string[];
    /**
     * The board's repos, one section each. Not derivable from `roots`: those
     * are cwds and checkouts alike, and which of them is one repo is a git
     * question the poll has already answered.
     */
    repos: McpRepo[];
    /**
     * Which repo each root in `roots` belongs to — a worktree and its checkout
     * both map to the checkout, so they are one section rather than two.
     */
    repoOf: Record<string, string>;
    ownRoot?: string;
  };
  /**
   * One map per probing brand: what that brand's CLI last said, keyed
   * `<root>|<name>`. Absent until the sheet asks for it — the tick never does,
   * because this costs a network round trip per server. A row with no entry
   * here keeps the state the two config reads gave it.
   */
  mcpHealth?: Partial<Record<BrandId, Map<string, McpHealth>>>;
  /** When that ask last completed, epoch ms — the gate on re-asking. */
  mcpHealthAt?: number;
  /** One fan-out at a time; the sheet can be reopened faster than it answers. */
  mcpHealthInFlight?: boolean;
  /** The one MCP login in flight, if any — what the cell says while it runs. */
  mcpLogin?: McpLoginLive;
  mcpLoginChild?: McpLoginSession;
  mcpLoginGen: number;
  mcpLoginRequest?: string;
  /** When the two MCP files were last read, epoch ms. */
  mcpAt: number;
};

type AuthHost = PanelActions & { auth: AuthState };

export function emptyAuth(): AuthState {
  const authTried: Partial<Record<BrandId, boolean>> = {};
  for (const brand of BRANDS) authTried[brand] = false;
  return {
    accounts: {},
    authTried,
    installed: {},
    authGen: 0,
    loginGen: 0,
    mcpLoginGen: 0,
    mcpAt: 0
  };
}

/**
 * Interval, not duration: the shortest gap between two reads of the MCP
 * configs. File reads only, but up to one per repo on the board.
 */
const MCP_READ_MS = 30_000;

/**
 * Interval, not duration: the shortest gap between two health fan-outs.
 *
 * Longer than `MCP_READ_MS` because this one spends a child process and a network
 * round trip per server rather than reading a file, and because what it reads
 * changes on the timescale of a server going down — not of a poll.
 */
const HEALTH_EVERY_MS = 60_000;

type AccountDescriptor = {
  startLogin(
    onEvent: (event: LoginEvent) => void,
    bin?: string
  ): Promise<LoginSession | { ok: false; reason: string }>;
  logout(bin?: string): Promise<{ ok: true } | { ok: false; reason: string }>;
};

/** Sign-in status comes from the adapter's `account` port through `core/signin.ts`. */
const ACCOUNT_ROW_DESCRIPTORS: Record<BrandId, AccountDescriptor> = {
  claude: {
    startLogin: startClaudeLogin,
    logout: claudeAuthLogout
  },
  grok: {
    startLogin: startGrokLogin,
    logout: grokAuthLogout
  },
  codex: {
    startLogin: startCodexLogin,
    logout: codexAuthLogout
  }
};

/**
 * Accounts rows for the wire. Undefined until the first status poll so the
 * nav keeps usage-only behaviour for pre-auth paints and old scenarios.
 */
export function accountsView(
  panel: AuthHost,
  sessions: readonly Session[],
  usage: UsageByBrand
): AccountView[] | undefined {
  if (BRANDS.some((brand) => !panel.auth.authTried[brand])) return undefined;
  const sessionCounts = accountSessionCounts(sessions);
  return accountRows(
    BRANDS.map((brand) => {
      const status = panel.auth.accounts[brand] ?? { loggedIn: false };
      const installUrl = adapter(brand)?.installUrl;
      return accountRow(status, {
        brand,
        sessionCount: sessionCounts[brand],
        usage: status.loggedIn ? usage.get(brand) : undefined,
        plan: status.plan,
        installed: panel.auth.installed[brand],
        ...(installUrl ? { installHost: new URL(installUrl).host } : {})
      });
    })
  );
}

export function waitingUsageWindows(): { id: string; short: string }[] | undefined {
  return pendingUsageWindows(BRANDS.map((brand) => adapter(brand)?.usage));
}

/** One pass's plan usage, per brand. Absent means a brand this build cannot ask
 *  about, or one nobody is signed in to. */
export type UsageByBrand = Map<BrandId, RateLimits>;

/** Unknown status keeps the model list full and prevents a speculative usage read. */
function signedInTo(panel: Pick<AuthHost, 'auth'>, brand: BrandId): boolean | undefined {
  // **The absence of a status is not a negative status**, and the difference is
  // load-bearing rather than pedantic. Claude's `account.status` answers `undefined`
  // on four paths, only one of which is a real "no": a missing binary, the 4s
  // `SPAWN_MS` timeout, a spawn error, and stdout that will not parse. Reading
  // any of the last three as "signed out" would drop every Claude row —
  // emptying the flyout, printing a sentence
  // that is untrue, and leaving `listedModels()` empty so an
  // `squadron-spawn` child silently loses its inherited model.
  //
  // So this reports what was *answered*, and `undefined` covers both "not
  // asked yet" and "asked, no answer". `installed` is what states a missing
  // binary, for both brands, which is why it is read separately.
  return panel.auth.accounts[brand]?.loggedIn;
}

/**
 * The two facts `offeredModels` filters on, for every brand in the registry.
 *
 * `installed` is its own reading rather than something inferred from auth,
 * because for one brand it cannot be: Grok's status is a `~/.grok/auth.json`
 * stat, which answers `loggedIn` perfectly well on a machine with no `grok`
 * binary at all. Claude's status does spawn its binary, so the two agree there
 * — for one brand out of two, which is not a rule.
 */
export function brandAvailability(panel: Pick<AuthHost, 'auth'>): BrandAvailability[] {
  return BRANDS.map((brand) => ({
    brand,
    installed: panel.auth.installed[brand],
    signedIn: signedInTo(panel, brand)
  }));
}

export async function refreshUsage(panel: AuthHost): Promise<UsageByBrand> {
  const view: UsageByBrand = new Map();
  for (const brand of BRANDS) {
    const source = adapter(brand)?.usage;
    if (!source || signedInTo(panel, brand) !== true) continue;
    view.set(
      brand,
      (await usageFor(brand, source)) ?? {
        windows: source.windows.map((window) => ({ ...window }))
      }
    );
  }
  return view;
}

// --- MCP servers -------------------------------------------------------------

export type { McpBoard };

/**
 * The MCP sheet for the wire: what the repos (and each brand's user config)
 * list, and which of those each brand's store says are unauthenticated.
 *
 * File reads every `MCP_READ_MS` — `claude mcp list` / `grok mcp doctor`
 * spend a network round trip per server, which is not a thing to do behind
 * a footer. No readable config returns `undefined`, which draws the
 * accounts popover exactly as it was before MCP shipped.
 */
export async function refreshMcpIfDue(panel: AuthHost, board: McpBoard): Promise<void> {
  // **`done` is the one phase this pass must not read over.** `mcpView` drops a
  // settled record, and a pass falling due in the seconds between a `done` and
  // its own `refreshMcpNow` dropped it early — painting Needs auth, Authorise
  // button and all, at a reader who had just finished authorising. Worst while
  // the reader is over in the browser: the poll returns early on a hidden
  // panel, so `mcpAt` goes stale and the first pass after the tab comes back is
  // due by construction.
  //
  // Only that phase. A pass during `starting`/`browser`/`waiting` clears
  // nothing and `overlayLive` repaints the cell busy over whatever it read, so
  // it is a no-op on screen — and widening this to every live record froze the
  // whole sheet, every other repo with it, for as long as one login the reader
  // abandoned in the browser sat on its pty. Sweeping an `error` is this pass's
  // own job. Before the stamp, so the pass after a login is due immediately.
  if (panel.auth.mcpLogin?.phase === 'done') return;
  if (panel.auth.mcpAt && Date.now() - panel.auth.mcpAt < MCP_READ_MS) return;
  panel.auth.mcpAt = Date.now();
  await mcpView(panel, board);
}

/** The board as it was last read, for a refresh that has no poll behind it. */
const lastBoard = (panel: AuthHost): McpBoard => ({
  roots: panel.auth.mcp?.roots ?? [],
  repos: panel.auth.mcp?.repos ?? [],
  repoOf: panel.auth.mcp?.repoOf ?? {},
  ...(panel.auth.mcp?.ownRoot ? { ownRoot: panel.auth.mcp.ownRoot } : {})
});

type McpReader = {
  read(panel: AuthHost, board: McpBoard): Promise<McpSnapshot>;
  /**
   * Asks one root's CLI what works. Absent where the read already states
   * reachability. Grok reads credentials; Codex's listing already combines
   * config and credential state, so neither shares this probe.
   */
  probe?: (root: string, binOverride: string | undefined) => Promise<Map<string, McpHealth>>;
};

const MCP_READERS: Record<BrandId, McpReader> = {
  claude: {
    read: (panel, board) =>
      readClaudeMcp({ roots: board.roots, health: panel.auth.mcpHealth?.claude }),
    probe: recheckMcpHealth
  },
  grok: {
    read: (_panel, board) => readGrokMcp({ roots: board.roots })
  },
  codex: {
    read: (_panel, board) =>
      readCodexMcp({
        // One child per repo, not per session cwd or worktree.
        roots: board.repos.map((repo) => repo.root),
        binOverride: configuredPath(adapter('codex'))
      })
  }
};

export async function mcpView(panel: AuthHost, board: McpBoard): Promise<void> {
  const loginAtRead = panel.auth.mcpLogin;
  const snapshots = await Promise.all(BRANDS.map((brand) => MCP_READERS[brand].read(panel, board)));
  const reading = foldBoard({ snapshots, board });
  if (!reading) {
    panel.auth.mcp = undefined;
    return;
  }
  // The live record outranks disk. Clear settled logins when this reading catches up.
  const settled = panel.auth.mcpLogin?.phase;
  if (panel.auth.mcpLogin === loginAtRead && (settled === 'error' || settled === 'done'))
    panel.auth.mcpLogin = undefined;
  panel.auth.mcp = {
    rows: reading.rows,
    roots: [...board.roots],
    repos: [...board.repos],
    repoOf: { ...board.repoOf },
    ...(board.ownRoot ? { ownRoot: board.ownRoot } : {})
  };
}

/**
 * Ask each probing brand's declaring roots what works.
 *
 * **Gated like every other read in this file.** The sheet posts on every open,
 * and this fans out one child per declaring root, each holding a 15s timeout —
 * ten open/close cycles would overlap ten fan-outs. `mcpHealthAt` is the same
 * shape `refreshMcpIfDue` uses for the tick.
 */
export async function refreshMcpHealthNow(panel: AuthHost): Promise<void> {
  if (panel.auth.mcpHealthInFlight) return;
  if (panel.auth.mcpHealthAt && Date.now() - panel.auth.mcpHealthAt < HEALTH_EVERY_MS) return;
  const rows = panel.auth.mcp?.rows ?? [];
  const roots = panel.auth.mcp?.roots ?? [];
  const asks = BRANDS.flatMap((brand) => {
    const probe = MCP_READERS[brand].probe;
    if (!probe) return [];
    const asking = healthRoots(rows, roots, brand);
    return asking.length ? [{ brand, probe, roots: asking }] : [];
  });
  if (!asks.length) return;
  panel.auth.mcpHealthInFlight = true;
  try {
    const results = await Promise.all(
      asks.map(async ({ brand, probe, roots: asking }) => {
        const bin = configuredPath(adapter(brand));
        const answers = await Promise.all(asking.map((root) => probe(root, bin)));
        return [brand, mergeHealth(undefined, answers)] as const;
      })
    );
    if (panel.disposed) return;
    panel.auth.mcpHealthAt = Date.now();
    panel.auth.mcpHealth = { ...panel.auth.mcpHealth, ...Object.fromEntries(results) };
    await mcpView(panel, lastBoard(panel));
  } finally {
    panel.auth.mcpHealthInFlight = false;
  }
}

function mergeHealth(
  base: Map<string, McpHealth> | undefined,
  answers: readonly Map<string, McpHealth>[]
): Map<string, McpHealth> {
  const merged = new Map(base ?? []);
  for (const answer of answers) for (const [key, value] of answer) merged.set(key, value);
  return merged;
}

export function mcpForWire(panel: AuthHost): McpView | undefined {
  if (!panel.auth.mcp) return undefined;
  return foldMcpView({
    rows: panel.auth.mcp.rows,
    live: panel.auth.mcpLogin,
    repos: panel.auth.mcp.repos,
    ...(panel.auth.mcp.ownRoot ? { ownRoot: panel.auth.mcp.ownRoot } : {})
  });
}

type McpAuthDriver = {
  notes: { browser: string; waiting: string };
  prepare(target: McpActionTarget): Promise<McpLoginPrepared | { ok: false; reason: string }>;
  settle?(panel: AuthHost, target: McpActionTarget): Promise<void>;
  disconnect(panel: AuthHost, target: McpActionTarget): Promise<void>;
};

function mcpNote(driver: McpAuthDriver, phase: McpLoginPhase, message?: string): string {
  if (phase === 'error') return message ?? 'Authorisation did not finish.';
  if (phase === 'starting') return 'Starting…';
  if (phase === 'browser') return driver.notes.browser;
  return driver.notes.waiting;
}

const MCP_AUTH_DRIVERS: Record<BrandId, McpAuthDriver> = {
  claude: {
    notes: {
      browser: 'Open this to authorise, then come back',
      waiting: 'Waiting for authorisation…'
    },
    async disconnect(panel, target) {
      const cwd = target.readCwd;
      const bin = configuredPath(adapter('claude'));
      await mcpLogout(target, bin);
      if (panel.disposed) return;
      // Keep the fresh verdict: stale health would outrank the logged-out cache.
      const said = await recheckMcpHealth(cwd, bin);
      panel.auth.mcpHealth = {
        ...panel.auth.mcpHealth,
        claude: mergeHealth(panel.auth.mcpHealth?.claude, [said])
      };
    },
    prepare: (target) =>
      prepareMcpLoginChild({ target, binOverride: configuredPath(adapter('claude')) }),
    async settle(panel, target) {
      const cwd = target.readCwd;
      // The token is in the keychain now. The *cache* is the open question —
      // nothing measured says a completed login prunes its own key — so the
      // CLI is asked to re-check before the files are read back.
      //
      // Its answer is kept, not only its side effect on the cache: dropping
      // it leaves `mcpHealth` holding the pre-login verdict, which
      // `withHealth` then re-applies over the fresher cache reading.
      const bin = configuredPath(adapter('claude'));
      const said = await recheckMcpHealth(cwd, bin);
      panel.auth.mcpHealth = {
        ...panel.auth.mcpHealth,
        claude: mergeHealth(panel.auth.mcpHealth?.claude, [said])
      };
    }
  },
  codex: {
    notes: {
      browser: 'Approve it in the browser, then come back',
      waiting: 'Approve it in the browser, then come back'
    },
    async disconnect(_panel, target) {
      await codexMcpLogout(target, { binOverride: configuredPath(adapter('codex')) });
    },
    prepare: (target) =>
      prepareCodexMcpLoginChild({ target, binOverride: configuredPath(adapter('codex')) })
  },
  grok: {
    notes: { browser: GROK_MCP_WAIT, waiting: GROK_MCP_WAIT },
    async disconnect(_panel, target) {
      await grokMcpLogout(target);
    },
    prepare: (target) =>
      prepareGrokMcpLoginChild({ target, binOverride: configuredPath(adapter('grok')) })
  }
};

function reportMcpAction(
  panel: AuthHost,
  operationId: string | undefined,
  phase: McpActionProgressMessage['phase'],
  message?: string
): void {
  if (!operationId || panel.disposed) return;
  const mcp = mcpForWire(panel);
  panel.post({
    type: 'mcpActionProgress',
    operationId,
    phase,
    ...(mcp ? { mcp } : {}),
    ...(message ? { message } : {})
  });
}

function reportMcpLogin(
  panel: AuthHost,
  phase: McpActionProgressMessage['phase'],
  message?: string
): void {
  const operationId = panel.auth.mcpLoginRequest;
  if (phase !== 'progress') panel.auth.mcpLoginRequest = undefined;
  reportMcpAction(panel, operationId, phase, message);
}

export async function startMcpLogin(
  panel: AuthHost,
  selection: unknown,
  operationId?: string
): Promise<void> {
  cancelMcpLogin(panel);
  const gen = ++panel.auth.mcpLoginGen;
  panel.auth.mcpLoginRequest = operationId;
  const current = (): boolean => !panel.disposed && gen === panel.auth.mcpLoginGen;
  try {
    await mcpView(panel, lastBoard(panel));
    if (!current()) return;
    const target = resolveMcpTarget(panel.auth.mcp?.rows ?? [], selection, 'login');
    if (!target) {
      reportMcpLogin(
        panel,
        'error',
        'MCP declaration changed or could not be checked. Reopen MCP and try again.'
      );
      void panel.refresh();
      return;
    }
    const driver = MCP_AUTH_DRIVERS[target.brand];
    panel.auth.mcpLogin = { target, phase: 'starting', note: mcpNote(driver, 'starting') };
    reportMcpLogin(panel, 'progress');
    const prepared = await driver.prepare(target);
    if (!current()) return;
    if ('ok' in prepared) {
      panel.auth.mcpLogin = { target, phase: 'error', note: prepared.reason };
      reportMcpLogin(panel, 'error', prepared.reason);
      void panel.refresh();
      return;
    }
    const who = { target };
    const session = prepared.start((event) => {
      if (!current()) return;
      if (event.type === 'url') {
        panel.auth.mcpLogin = {
          ...who,
          phase: 'browser',
          note: driver.notes.browser,
          url: event.url
        };
      } else if (event.type === 'phase') {
        if (event.phase === 'done') {
          // The credential is stored before the CLI's health/cache reading catches up.
          panel.auth.mcpLogin = { ...who, phase: 'done' };
          panel.auth.mcpLoginChild = undefined;
          reportMcpLogin(panel, 'progress');
          void (async () => {
            try {
              try {
                await driver.settle?.(panel, target);
              } catch {
                // A failed health check must not skip the configuration reread.
              }
              if (!current()) return;
              await refreshMcpNow(panel);
              if (current()) reportMcpLogin(panel, 'done');
            } catch {
              if (current()) {
                panel.auth.mcpLogin = undefined;
                reportMcpLogin(
                  panel,
                  'error',
                  'Authorised, but the server state could not be refreshed. Reopen MCP to check it.'
                );
              }
            }
          })();
          return;
        }
        panel.auth.mcpLogin = {
          ...who,
          phase: event.phase,
          note: mcpNote(driver, event.phase, event.message),
          // The CLI emits its URL and waiting phase separately.
          ...(panel.auth.mcpLogin?.url ? { url: panel.auth.mcpLogin.url } : {})
        };
      } else {
        panel.auth.mcpLogin = { ...who, phase: 'error', note: event.message };
      }
      reportMcpLogin(
        panel,
        panel.auth.mcpLogin.phase === 'error' ? 'error' : 'progress',
        panel.auth.mcpLogin.note
      );
      void panel.refresh();
    });
    if (!current()) {
      if (!('ok' in session)) session.cancel();
      return;
    }
    if ('ok' in session) {
      panel.auth.mcpLogin = { ...who, phase: 'error', note: session.reason };
      reportMcpLogin(panel, 'error', session.reason);
      void panel.refresh();
      return;
    }
    if (panel.auth.mcpLogin?.phase === 'done' || panel.auth.mcpLogin?.phase === 'error') {
      session.cancel();
      return;
    }
    panel.auth.mcpLoginChild = session;
  } catch {
    if (!current()) return;
    panel.auth.mcpLogin = undefined;
    reportMcpLogin(panel, 'error', 'Could not start authorisation. Try again.');
    void panel.refresh();
  }
}

export function cancelMcpLogin(panel: AuthHost, operationId?: string): void {
  if (operationId && operationId !== panel.auth.mcpLoginRequest) return;
  panel.auth.mcpLoginGen += 1;
  panel.auth.mcpLoginChild?.cancel();
  panel.auth.mcpLoginChild = undefined;
  panel.auth.mcpLogin = undefined;
  reportMcpLogin(panel, 'cancelled');
}

export async function mcpDisconnect(
  panel: AuthHost,
  selection: unknown,
  operationId?: string
): Promise<void> {
  try {
    await mcpView(panel, lastBoard(panel));
    if (panel.disposed) return;
    const target = resolveMcpTarget(panel.auth.mcp?.rows ?? [], selection, 'disconnect');
    if (!target) {
      reportMcpAction(
        panel,
        operationId,
        'error',
        'MCP declaration changed or could not be checked. Reopen MCP and try again.'
      );
      void panel.refresh();
      return;
    }
    await MCP_AUTH_DRIVERS[target.brand].disconnect(panel, target);
    if (panel.disposed) return;
    await refreshMcpNow(panel);
    const stillConnected = resolveMcpTarget(panel.auth.mcp?.rows ?? [], selection, 'disconnect');
    reportMcpAction(
      panel,
      operationId,
      stillConnected ? 'error' : 'done',
      stillConnected ? 'Could not disconnect. Try again.' : undefined
    );
  } catch {
    reportMcpAction(
      panel,
      operationId,
      'error',
      'Could not disconnect or refresh the server state. Reopen MCP and try again.'
    );
    void panel.refresh();
  }
}

/** Re-read the two files off-cycle, after a login changed one of them. */
async function refreshMcpNow(panel: AuthHost): Promise<void> {
  if (panel.disposed) return;
  await mcpView(panel, lastBoard(panel));
  void panel.refresh();
}

/**
 * Every brand's sign-in, on every pass. A CLI is started only when its stored
 * answer is missing or `force` says a verb changed it — `core/signin.ts`. A
 * fold the `authGen` guard drops is repaired by the next pass, which reads
 * the record the dropped one's ask wrote.
 *
 * `relist` forces an account catalog's re-read as well. Only `squadron-models`
 * asks for it: a sign-in or sign-out of the brand that has one moves its stamp,
 * which re-reads it unforced, so a verb forcing it would only spend an
 * app-server on every other brand's login.
 */
export async function refreshAuthIfDue(
  panel: Pick<AuthHost, 'auth'>,
  opts: { force?: boolean; relist?: boolean } = {}
): Promise<void> {
  const force = opts.force === true;
  const generation = ++panel.auth.authGen;
  const now = Date.now();
  const answers: Partial<Record<BrandId, AccountRowStatus | undefined>> = {};
  await Promise.all(
    BRANDS.map(async (brand) => {
      const cli = adapter(brand);
      if (!cli?.account) return;
      const override = configuredPath(cli);
      answers[brand] = await signInFor(brand, cli.account, { now, force, override });
      const signedIn = (answers[brand] ?? panel.auth.accounts[brand])?.loggedIn === true;
      await refreshCatalog(brand, cli, { signedIn, now, force: opts.relist, override });
    })
  );
  const installed = Object.fromEntries(
    await Promise.all(
      BRANDS.map(async (brand) => {
        const cli = adapter(brand);
        if (!cli) return [brand, false] as const;
        return [brand, (await cli.resolveBinary(configuredPath(cli))).ok] as const;
      })
    )
  );
  completeAccountPoll(panel.auth, generation, answers, installed);
}

export async function forceAuth(panel: AuthHost): Promise<void> {
  await refreshAuthIfDue(panel, { force: true });
  void panel.refresh();
}

export async function startLogin(panel: AuthHost, brand: BrandId): Promise<void> {
  cancelLogin(panel);
  const gen = panel.auth.loginGen;
  let opened = false;
  // Whether the URL is opened from here is the adapter's to say: Grok's CLI is
  // the one that still opens its own, and the other two are opened here. The
  // sheet surfaces the URL either way; Open browser posts openLoginUrl.
  const onEvent = (event: LoginEvent): void => {
    // See `AuthState.loginGen`: cancelled children must not reopen the sheet.
    if (panel.disposed || gen !== panel.auth.loginGen) return;
    if (event.type === 'url') {
      panel.post({
        type: 'loginProgress',
        brand,
        // The adapter owns the phase. Absence means `LoginProgressMessage.phase`.
        url: event.url,
        ...(event.userCode ? { userCode: event.userCode } : {})
      });
      // Posted first, so the sheet is holding the code before the tab takes
      // focus — the reader needs to carry one into the other. Only for a CLI
      // that opens none itself; `CliAdapter.loginOpensBrowser` says which, and
      // absent means it does.
      //
      // Once per attempt, because a `url` event is a revision as much as an
      // announcement — Grok re-sends it to attach a late `userCode`. The sheet
      // repaints from every one; a second tab is not a corrected first.
      if (!opened && adapter(brand)?.loginOpensBrowser === false) {
        opened = true;
        openLoginUrl(event.url);
      }
    } else if (event.type === 'phase') {
      panel.post({
        type: 'loginProgress',
        brand,
        phase: event.phase,
        message: event.message
      });
      if (event.phase === 'done') {
        panel.auth.login = undefined;
        void forceAuth(panel);
      }
    } else if (event.type === 'error') {
      panel.post({
        type: 'loginProgress',
        brand,
        phase: 'error',
        message: event.message
      });
    }
    // `exit` needs no arm: a clean close emits `phase: 'done'` just above it,
    // and handling both spawned two `auth status` probes per sign-in.
  };
  const session = await ACCOUNT_ROW_DESCRIPTORS[brand].startLogin(
    onEvent,
    configuredPath(adapter(brand))
  );
  // Same race the MCP login guards: the reader may have cancelled during
  // `claudeBinary`'s filesystem walk, bumping the gen with no child to kill
  // while the spawn landed anyway. Four such children were found alive five
  // days on, holding an old CLI version resident; plain SIGTERM cleared them,
  // so they had never been signalled at all.
  if (gen !== panel.auth.loginGen) {
    if (!('ok' in session)) session.cancel();
    return;
  }
  if ('ok' in session && session.ok === false) {
    panel.post({
      type: 'loginProgress',
      brand,
      phase: 'error',
      message: session.reason
    });
    return;
  }
  panel.auth.login = session as LoginSession;
}

export function cancelLogin(panel: AuthHost): void {
  panel.auth.loginGen += 1;
  panel.auth.login?.cancel();
  panel.auth.login = undefined;
}

export function openLoginUrl(raw: string): void {
  const url = webUri(raw);
  if (!url) return;
  void vscode.env.openExternal(vscode.Uri.parse(url.href));
}

export function openInstallPage(brand: BrandId): void {
  const cli = adapter(brand);
  if (cli) void vscode.env.openExternal(vscode.Uri.parse(cli.installUrl));
}

export async function confirmSignOut(panel: AuthHost, brand: BrandId): Promise<void> {
  let result: { ok: true } | { ok: false; reason: string } = {
    ok: false,
    reason: 'Sign-out did not finish.'
  };
  try {
    result = await ACCOUNT_ROW_DESCRIPTORS[brand].logout(configuredPath(adapter(brand)));
    // A later sign-in as a different account must not rehydrate this one's
    // figure. It matters more since the sources are merged per window rather
    // than ranked — a heavier old figure used to be displaced by the first
    // reading of the new account, and now wins its window until that window rolls.
    //
    // The CLI's own dumps are not ours to drop and not ours to attribute:
    // nothing in one names an account. So they can still seed the new account's
    // chip until `prune.ts` sweeps them at seven days — the weekly window's own
    // length, so nothing outlives a window it could have been a reading of.
    await forgetUsageFor(brand);
    // Auth feedback belongs on the panel. Keep the sheet through the re-poll
    // so it can show a sign-out failure.
    if (panel.disposed) return;
    await forceAuth(panel);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Sign-out did not finish.';
    result = { ok: false, reason: detail.slice(0, 200) };
  } finally {
    // The locked wait sheet has no Cancel. Post a result even if a probe throws.
    if (!panel.disposed) {
      panel.post(
        result.ok
          ? { type: 'signOutResult', brand, phase: 'done' }
          : { type: 'signOutResult', brand, phase: 'error', message: result.reason }
      );
    }
  }
}
