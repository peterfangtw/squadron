/** Account status and managed device login over a private Codex app-server. */

import * as path from 'node:path';
import type { LoginEvent, LoginSession } from '../accounts';
import { fileStamp } from '../files';
import { CODEX_DIR } from '../paths';
import { codexModels, refreshCodexModels, noteCodexModelAccount } from './models';
import { connectCodex, type CodexConnector } from './runtime';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type CodexAuthStatus = {
  loggedIn: boolean;
  email?: string;
  /** Chip text, composed by `codexPlanLabel` — never the app-server's own slug. */
  plan?: string;
  mode?: string;
};

/**
 * The chip, per `planType` the app-server sends on `account/read`.
 *
 * **Seventeen slugs, eight chips.** The full enum is Codex 0.150's, taken from
 * t3code's generated app-server schema (`effect-codex-app-server`, generated
 * from the same wire we speak); the business / enterprise / edu families each
 * fold to one word because the split inside them is billing, not entitlement.
 *
 * `pro → Pro 20x` and `prolite → Pro 5x` are the two that carry a multiplier
 * this wire does not: the slug says neither, and t3code prints them that way
 * because the tiers are sold that way.
 *
 * **A slug not on this list draws no chip.** `unknown` is the app-server's own
 * "no answer", and a slug added after this table is the same answer arriving by
 * a different route — `TASK_done_accounts_auth.md` says omit the badge when the
 * plan is unknown, and title-casing one into `Ultra Max` would state a tier
 * nobody sells rather than degrade.
 */
const CODEX_PLAN_LABELS: Readonly<Record<string, string>> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro 20x',
  prolite: 'Pro 5x',
  team: 'Team',
  self_serve_business_prolite: 'Business',
  self_serve_business_usage_based: 'Business',
  business: 'Business',
  ent26: 'Enterprise',
  enterprise_cbp_automation: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise',
  enterprise: 'Enterprise',
  edu: 'Edu',
  edu_plus: 'Edu',
  edu_pro: 'Edu'
};

export function codexPlanLabel(planType: string | undefined): string | undefined {
  return CODEX_PLAN_LABELS[planType?.trim().toLowerCase() ?? ''];
}

export function parseCodexAuthStatus(value: unknown): CodexAuthStatus | undefined {
  if (!isRecord(value) || !Object.hasOwn(value, 'account')) return undefined;
  if (value.account === null) return { loggedIn: false };
  if (!isRecord(value.account) || typeof value.account.type !== 'string') return undefined;
  const mode = value.account.type;
  if (!['chatgpt', 'apiKey', 'amazonBedrock'].includes(mode)) return undefined;
  const plan =
    typeof value.account.planType === 'string' ? codexPlanLabel(value.account.planType) : undefined;
  return {
    loggedIn: true,
    mode,
    ...(typeof value.account.email === 'string' && value.account.email.trim()
      ? { email: value.account.email.trim() }
      : {}),
    ...(plan ? { plan } : {})
  };
}

function accountKey(status: CodexAuthStatus): string {
  return status.loggedIn
    ? `in:${status.mode ?? 'unknown'}:${status.email ?? ''}:${status.plan ?? ''}`
    : 'out';
}

/**
 * Where a ChatGPT sign-in is written, and what `codexAuthStamp` watches.
 * Rewritten whole on every token refresh (~10 days), which costs one ask.
 * A reader on `cli_auth_credentials_store = keyring` writes no file at all —
 * there the stamp never moves and only a forced ask notices a change.
 */
const CODEX_AUTH_FILE = path.join(CODEX_DIR, 'auth.json');

export function codexAuthStamp(file = CODEX_AUTH_FILE): Promise<string> {
  return fileStamp(file);
}

/**
 * `account/read`, and with `models` the catalog too, on one app-server. The
 * account key is noted either way, so a status read alone still retires the
 * previous account's catalog — `refreshCatalog` then fetches the new one.
 */
export async function codexAuthStatus(
  override?: string,
  connector: CodexConnector = () => connectCodex(override),
  models = true
): Promise<CodexAuthStatus | undefined> {
  const opened = await connector();
  if (!opened.ok) return undefined;
  const { client } = opened.connection;
  try {
    const status = parseCodexAuthStatus(
      await client.request('account/read', { refreshToken: false })
    );
    if (!status) return undefined;
    noteCodexModelAccount(accountKey(status));
    if (models) await refreshCodexModels(client).catch(() => false);
    return status;
  } catch {
    return undefined;
  } finally {
    opened.connection.close();
  }
}

/**
 * Re-read the catalog, answering whether this account's is now held. A read
 * that never reached the server is a failure even with rows in hand: those may
 * be the previous account's, which only a successful `account/read` retires.
 */
export async function refreshCodexCatalog(
  override?: string,
  connector: CodexConnector = () => connectCodex(override)
): Promise<boolean> {
  const status = await codexAuthStatus(override, connector);
  return status !== undefined && codexModels().length > 0;
}

export async function codexAuthLogout(
  override?: string,
  connector: CodexConnector = () => connectCodex(override)
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const opened = await connector();
  if (!opened.ok) return opened;
  try {
    await opened.connection.client.request('account/logout');
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Codex logout failed'
    };
  } finally {
    opened.connection.close();
  }
}

type LoginStart = {
  loginId: string;
  url: string;
  userCode?: string;
};

export function parseCodexLoginStart(value: unknown): LoginStart | undefined {
  if (!isRecord(value) || typeof value.loginId !== 'string' || !value.loginId) return undefined;
  if (value.type === 'chatgptDeviceCode') {
    if (typeof value.verificationUrl !== 'string' || typeof value.userCode !== 'string') {
      return undefined;
    }
    return { loginId: value.loginId, url: value.verificationUrl, userCode: value.userCode };
  }
  if (value.type === 'chatgpt' && typeof value.authUrl === 'string') {
    return { loginId: value.loginId, url: value.authUrl };
  }
  return undefined;
}

/**
 * Start device-code login and retain the app-server until a correlated
 * completion has been verified against an authoritative `account/read`.
 * `submit` is intentionally empty.
 */
export async function startCodexLogin(
  onEvent: (event: LoginEvent) => void,
  override?: string,
  connector: CodexConnector = () => connectCodex(override, 30_000),
  loginMs = 10 * 60_000
): Promise<LoginSession | { ok: false; reason: string }> {
  onEvent({ type: 'phase', phase: 'starting' });
  const opened = await connector();
  if (!opened.ok) return opened;
  const { client } = opened.connection;
  let loginId: string | undefined;
  let completed = false;
  let updated = false;
  let canceled = false;
  let settled = false;
  let verifying = false;
  let handedOff = false;
  let terminalReason: string | undefined;
  const earlyCompletions: Record<string, unknown>[] = [];

  const deadline = setTimeout(() => fail('Codex sign in timed out. Try again.'), loginMs);
  deadline.unref();
  const close = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    opened.connection.close();
  };
  const fail = (message: string): void => {
    if (settled || canceled) return;
    terminalReason = message;
    if (handedOff) {
      onEvent({ type: 'error', message });
      onEvent({ type: 'phase', phase: 'error', message });
    }
    close();
  };
  const verify = async (): Promise<void> => {
    if (verifying || settled || canceled || !completed) return;
    verifying = true;
    // Sampled before the read, not after: an `account/updated` that lands while
    // this request is in flight finds `verifying` set and returns, so testing
    // the flag afterwards would fail a login on a read that predates the
    // credentials it is looking for.
    const hadUpdate = updated;
    try {
      const status = parseCodexAuthStatus(
        await client.request('account/read', { refreshToken: true })
      );
      if (!status?.loggedIn) {
        // Not an authoritative no while the account may still be settling: if
        // `account/updated` had not arrived, let it re-run this. Only a read
        // taken *after* that update is evidence the login did not take, and
        // the deadline still backstops an update that never comes.
        if (!hadUpdate) {
          verifying = false;
          // An update that arrived while the read was in flight hit the guard
          // above and returned, so this is the only thing left holding it: drop
          // it here and the flow parks until the deadline on a login that
          // worked. Sampling `hadUpdate` early prevents the wrong *failure*;
          // this is what recovers the retry it costs.
          if (updated) void verify();
          return;
        }
        fail('Codex sign in completed without an authenticated account.');
        return;
      }
      noteCodexModelAccount(accountKey(status));
      if (!settled && !canceled) onEvent({ type: 'phase', phase: 'done' });
      await refreshCodexModels(client).catch(() => false);
      close();
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Could not verify Codex sign in');
    }
  };

  const completedBy = (params: Record<string, unknown>): void => {
    if (settled || params.loginId !== loginId) return;
    if (params.success !== true) {
      fail(
        typeof params.error === 'string' && params.error.trim()
          ? params.error.trim()
          : 'Codex sign in did not finish.'
      );
      return;
    }
    // An account update from before this correlated completion says nothing
    // about the credentials this flow just wrote.
    completed = true;
    updated = false;
    void verify();
  };

  client.onNotification((method, params) => {
    if (settled || !isRecord(params)) return;
    if (method === 'account/updated') {
      if (completed) {
        updated = true;
        void verify();
      }
      return;
    }
    if (method !== 'account/login/completed') return;
    if (loginId === undefined) {
      earlyCompletions.push(params);
      return;
    }
    completedBy(params);
  });
  opened.connection.onExit(() => {
    if (!settled && !canceled) fail('Codex app-server exited before sign in completed.');
  });

  try {
    const start = parseCodexLoginStart(
      await client.request('account/login/start', { type: 'chatgptDeviceCode' })
    );
    if (!start) {
      fail('Codex returned a malformed login response.');
      return { ok: false, reason: 'Codex returned a malformed login response.' };
    }
    loginId = start.loginId;
    for (const params of earlyCompletions) completedBy(params);
    earlyCompletions.length = 0;
    if (settled) return { ok: false, reason: terminalReason ?? 'Codex sign in did not finish.' };
    onEvent({
      type: 'url',
      url: start.url,
      ...(start.userCode ? { userCode: start.userCode } : {})
    });
    onEvent({ type: 'phase', phase: start.userCode ? 'waiting' : 'browser' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Could not start Codex sign in';
    fail(reason);
    return { ok: false, reason };
  }

  handedOff = true;
  return {
    submit() {
      /* device login is completed in the browser */
    },
    cancel() {
      if (settled || canceled) return;
      canceled = true;
      const id = loginId;
      if (!id) {
        close();
        return;
      }
      const cancelDeadline = setTimeout(close, 4_000);
      cancelDeadline.unref();
      void client
        .request('account/login/cancel', { loginId: id })
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(cancelDeadline);
          close();
        });
    }
  };
}
