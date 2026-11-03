/**
 * Machine-wide Claude authentication: status, logout, and the login child.
 *
 * Status is the public CLI seam — `claude auth status --json` — never Keychain
 * and never a credentials file under `~/.claude`. The one thing status does not
 * say is the plan's sold name, and that fact is read from the CLI's own config
 * file instead: `claudePlanLabel` below. Login is a separate child
 * (`claude auth login`) whose stdout carries the OAuth URL and a paste prompt;
 * the panel feeds the code on stdin. Observed 2026-08-09 (CLI 2.1.226):
 * non-TTY login prints `Opening browser…`, a full authorize URL, then
 * `Paste code here if prompted >`.
 *
 * Brand spelling stays here. The webview paints our own shapes only.
 * Grok login lives in `core/grok/auth.ts` — this file stays Claude-only so a
 * second brand does not grow an arm here (roadmap 57).
 */

import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { settledPrefix, type LoginEvent, type LoginSession } from '../accounts';
import { claudeBinary } from '../bin';
import * as platform from '../platform';
import { fileStamp } from '../files';
import type { BrandId } from '../model';
import { CLAUDE_CONFIG_FILE } from '../paths';

/** How long a status / logout spawn may take before we treat it as missing. */
const SPAWN_MS = 4000;

/**
 * What `claude auth status --json` has been observed to say.
 *
 * Signed-out (2026-08-09): `{ loggedIn: false, authMethod: "none",
 * apiProvider: "firstParty" }`, exit 1. Signed-in (2026-09-01, CLI 2.1.241)
 * adds `email`, `orgId`, `orgName` and `subscriptionType` — and nothing else,
 * which is why the parser no longer guesses at five other spellings of those
 * two. Only fields that arrive are kept; never invent email / plan.
 */
export type ClaudeAuthStatus = {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  /** Present only when the CLI actually said so. */
  email?: string;
  /** The CLI's own word, lowercase: `max`, `pro`. Not the chip — that is `plan`. */
  subscriptionType?: string;
  /** Chip text, chosen by `claudePlanLabel`. */
  plan?: string;
};

export type { BrandId };

/**
 * Parse status JSON. Exit code is not required: `loggedIn: false` is enough,
 * and a body that will not parse is treated as unknown-out rather than a throw.
 */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== 'object') return undefined;
    const o = raw as Record<string, unknown>;
    if (typeof o.loggedIn !== 'boolean') return undefined;
    const out: ClaudeAuthStatus = { loggedIn: o.loggedIn };
    if (typeof o.authMethod === 'string') out.authMethod = o.authMethod;
    if (typeof o.apiProvider === 'string') out.apiProvider = o.apiProvider;
    if (typeof o.email === 'string' && o.email.trim()) out.email = o.email.trim();
    if (typeof o.subscriptionType === 'string' && o.subscriptionType.trim()) {
      out.subscriptionType = o.subscriptionType.trim();
    }
    return out;
  } catch {
    return undefined;
  }
}

/** `oauthAccount` out of the CLI's config text, or nothing we can read. */
function oauthAccountOf(text: string): Record<string, unknown> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const account = (raw as Record<string, unknown>).oauthAccount;
  return account && typeof account === 'object' ? (account as Record<string, unknown>) : undefined;
}

/**
 * The account's rate-limit tier — the one fact that separates the two plans
 * `subscriptionType` calls `max`, and the one `claude auth status --json` does
 * not carry.
 *
 * **Read from the config file, not the credentials.** Observed 2026-09-01, CLI
 * 2.1.241: the CLI's own accessor takes `rateLimitTier` off the Keychain entry,
 * and `~/.claude.json`'s `oauthAccount` holds the same string — both said
 * `default_claude_max_20x` here. The config file is what this reads; the rule
 * at the head of this file is no Keychain and no credentials file, and it is
 * neither, being already this repo's source for MCP servers.
 *
 * **One key, because only one has been watched carry the tier.**
 * `organizationRateLimitTier` is the one that matched the Keychain copy;
 * `userRateLimitTier` sat beside it as `null`. Neither is read by the CLI
 * itself — searched in the 2.1.241 bundle, both appear only where a profile
 * fetch writes them — so there is no precedence to copy and a rule for the two
 * disagreeing would be invented rather than observed. A populated seat tier is
 * news: handle it when one is seen.
 */
export function parseClaudeRateLimitTier(text: string): string | undefined {
  const tier = oauthAccountOf(text)?.organizationRateLimitTier;
  return typeof tier === 'string' && tier.trim() ? tier.trim() : undefined;
}

/** The shape the 2.1.316 bundle accepts for `plan_display_name`, copied. */
const PLAN_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} .+-]{0,38}[\p{L}\p{N}+])?$/u;

/**
 * The plan's sold name, as the account profile states it: `Ultra` on an account
 * whose tier is still `default_claude_max_20x`, read 2026-11-02 on CLI 2.1.316.
 * The CLI prefers this over its own display switch, and refuses what fails
 * `PLAN_NAME`, so a name that fails it here is treated as unstated.
 */
export function parseClaudePlanName(text: string): string | undefined {
  const name = oauthAccountOf(text)?.planDisplayName;
  return typeof name === 'string' && PLAN_NAME.test(name) ? name : undefined;
}

/**
 * The chip. The account's stated name wins, as it does in the CLI, so a rename
 * reaches it with no release of ours. A stated name never makes a plan of a
 * word outside the four.
 */
export function claudePlanLabel(
  subscriptionType: string | undefined,
  rateLimitTier?: string,
  planName?: string
): string | undefined {
  const word = subscriptionType?.trim().toLowerCase();
  if (word === undefined || !isPlanWord(word)) return undefined;
  return planName ?? claudeTableLabel(word, rateLimitTier);
}

/** The chip for a signed-in `subscriptionType`, off the CLI's config text. */
export function claudePlanOfConfig(
  subscriptionType: string,
  configText: string
): string | undefined {
  return claudePlanLabel(
    subscriptionType,
    parseClaudeRateLimitTier(configText),
    parseClaudePlanName(configText)
  );
}

const PLAN_WORDS = ['max', 'pro', 'team', 'enterprise'] as const;
type PlanWord = (typeof PLAN_WORDS)[number];

function isPlanWord(word: string): word is PlanWord {
  return (PLAN_WORDS as readonly string[]).includes(word);
}

/**
 * The chip with no stated name: `Ultra`, `Max`, `Pro`, `Team`, `Enterprise`.
 *
 * **Two switches out of the 2.1.241 binary, relabelled.** The tier half is
 * `max` + `default_claude_max_5x`/`default_claude_max_20x` →
 * `"max_5x"`/`"max_20x"`, any other tier under Max → `"max_other"`; 2.1.316
 * still holds only those `default_claude_*` tiers, spelled for plans sold since
 * as Max and Ultra. `Max` names one plan now, so `max_other`, which a failed
 * config read also lands on, draws no chip rather than a guess. The plan half
 * is that CLI's own display switch — `enterprise` · `team` · `max` · `pro`, and
 * a default of `Claude API`, which is not a subscription.
 *
 * **A word outside those four draws no chip**, per `TASK_done_accounts_auth.md`:
 * omit the badge when the plan is unknown. (The Agent SDK spells the same fact
 * `claude_max_20x_subscription` on its `init.account.subscriptionType`; if the
 * CLI ever adopts that spelling it belongs here as more cases, not as a second
 * reader.)
 */
function claudeTableLabel(word: PlanWord, rateLimitTier: string | undefined): string | undefined {
  switch (word) {
    case 'max':
      if (rateLimitTier === 'default_claude_max_5x') return 'Max';
      if (rateLimitTier === 'default_claude_max_20x') return 'Ultra';
      return undefined;
    case 'pro':
      return 'Pro';
    case 'team':
      return 'Team';
    case 'enterprise':
      return 'Enterprise';
  }
}

/** The config's text, empty when it cannot be read: such text states no plan. */
async function readClaudeConfigText(): Promise<string> {
  try {
    return await fs.readFile(CLAUDE_CONFIG_FILE, 'utf8');
  } catch {
    return '';
  }
}

/** Status plus the chip, which costs one file read and only when signed in. */
async function withPlan(
  status: ClaudeAuthStatus | undefined
): Promise<ClaudeAuthStatus | undefined> {
  if (!status?.subscriptionType) return status;
  const plan = claudePlanOfConfig(status.subscriptionType, await readClaudeConfigText());
  return plan ? { ...status, plan } : status;
}

/**
 * The fields of `oauthAccount` a sign-in, sign-out or account switch changes —
 * the row's email and plan chip, and the account and org they belong to.
 * **Not `profileFetchedAt`**, which moves every time the CLI refetches the
 * profile and would cost an ask each time.
 *
 * The CLI clears the whole block on sign-out: 2.1.289's bundle has one write of
 * `oauthAccount=void 0`, in the config reset beside the account's model caches
 * (read from the bundle 2026-10-05, not observed live — a live sign-out ends
 * every running session).
 */
const STAMPED = [
  'accountUuid',
  'emailAddress',
  'organizationUuid',
  'organizationType',
  'organizationRateLimitTier',
  'planDisplayName'
] as const;

/** The last stamp read per file, and the write it was read from. */
const stamped = new Map<string, { at: string; stamp: string }>();

/**
 * This account's fingerprint in the CLI's config, for `core/signin.ts`.
 *
 * Parsed only when the file's write time moves. Running sessions rewrite this
 * file constantly (144 KB here), so **a read caught mid-write keeps the last
 * good stamp**, or answers nothing when there is none to keep: a torn read must
 * not be a third value, which would cost an ask on the way in and another on
 * the way out — and, written to the shared store, one in every other window.
 */
export async function claudeAuthStamp(file = CLAUDE_CONFIG_FILE): Promise<string | undefined> {
  const at = await fileStamp(file);
  if (at === 'absent') return 'absent';
  const held = stamped.get(file);
  if (held?.at === at) return held.stamp;
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return held?.stamp;
  }
  const account = (raw as { oauthAccount?: unknown } | null)?.oauthAccount;
  const stamp =
    account && typeof account === 'object'
      ? JSON.stringify(STAMPED.map((key) => (account as Record<string, unknown>)[key] ?? null))
      : 'none';
  stamped.set(file, { at, stamp });
  return stamp;
}

/**
 * Proactive machine-wide status. Uses `claudeBinary` so Finder-launched hosts
 * still find `~/.local/bin/claude`. A missing binary or a hung spawn returns
 * `undefined` — the panel keeps the previous reading rather than painting a lie.
 */
export async function claudeAuthStatus(override?: string): Promise<ClaudeAuthStatus | undefined> {
  const bin = await claudeBinary(override);
  if (!bin.ok) return undefined;
  try {
    // Exit 1 when signed out still yields stdout JSON — that is success for us.
    const { stdout } = await platform.executables.exec(bin.program, ['auth', 'status', '--json'], {
      timeout: SPAWN_MS,
      maxBuffer: 64 * 1024
    });
    return await withPlan(parseClaudeAuthStatus(stdout));
  } catch (error) {
    const failed = error as { stdout?: string; killed?: boolean; code?: unknown };
    // Timed out / missing binary: no answer.
    if (failed.killed === true || typeof failed.code === 'string') return undefined;
    // Non-zero exit with body (signed out): still parse.
    if (typeof failed.stdout === 'string') {
      return await withPlan(parseClaudeAuthStatus(failed.stdout));
    }
    return undefined;
  }
}

/**
 * `claude auth logout`. Returns whether the process exited 0. Callers re-poll
 * status afterwards rather than trusting this alone.
 */
export async function claudeAuthLogout(
  override?: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const bin = await claudeBinary(override);
  if (!bin.ok) return { ok: false, reason: bin.reason };
  try {
    await platform.executables.exec(bin.program, ['auth', 'logout'], {
      timeout: SPAWN_MS,
      maxBuffer: 64 * 1024
    });
    return { ok: true };
  } catch (error) {
    const failed = error as { message?: string; stderr?: string; killed?: boolean };
    if (failed.killed) return { ok: false, reason: 'Logout timed out.' };
    const detail = (failed.stderr || failed.message || 'logout failed').trim();
    return { ok: false, reason: detail.slice(0, 200) };
  }
}

// --- login child -------------------------------------------------------------

/**
 * Pull an authorize URL out of a login stdout chunk. The CLI prints
 * `If the browser didn't open, visit: https://…` and sometimes the bare URL.
 *
 * **The host is a preference, not a requirement.** It is `claude.com` today and
 * it has moved before; pinning it meant a moved host painted a sheet with no
 * link, no Copy and no Open browser — a sign-in with nowhere to go, and every
 * test green because the fixture prints the host we wrote. A labelled line wins
 * outright; otherwise any `/oauth/authorize` link does, `claude.com` first.
 *
 * Styling comes off first, as `parseDeviceAuth` does it for Grok: nothing in a
 * URL token stops at an escape, so a styled link keeps its own reset code and
 * opens a tab at a URL nobody serves.
 */
export function loginUrlFrom(text: string): string | undefined {
  const clean = text.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
  const labeled = clean.match(/(?:visit|open|browser)[:\s]+(https:\/\/[^\s'"<>]+)/i);
  if (labeled?.[1]) return labeled[1];
  const links = clean.match(/https:\/\/[^\s'"<>]+\/oauth\/authorize[^\s'"<>]*/g) ?? [];
  return links.find((link) => link.startsWith('https://claude.com/')) ?? links[0];
}

export function loginWantsPaste(text: string): boolean {
  return /paste code here/i.test(text) || /paste the code/i.test(text);
}

/**
 * Start the Claude paste-code login. Emits events as stdout arrives.
 *
 * **`BROWSER=true` silences the CLI's own open, and the host opens instead.**
 * This CLI honours `$BROWSER` and a `true` there is a no-op command, so the
 * open is suppressed rather than redirected. The tab it would have opened is a
 * *different door* — loopback `redirect_uri`, no paste — from the URL it prints
 * on stdout, which is the one the sheet shows and wants a code for; a reader
 * who finished in the CLI's tab left the sheet still asking to paste. Observed,
 * dated and versioned: `docs/reference/cli_state/claude/auth.md`.
 *
 * **Move this with `claudeAdapter.loginOpensBrowser`**, which is `false` for
 * this reason and no other. Either alone gives the reader no tab or two.
 */
export async function startClaudeLogin(
  onEvent: (event: LoginEvent) => void,
  override?: string
): Promise<LoginSession | { ok: false; reason: string }> {
  const bin = await claudeBinary(override);
  if (!bin.ok) return { ok: false, reason: bin.reason };

  onEvent({ type: 'phase', phase: 'starting' });

  const spawned = platform.executables.spawn(bin.program, ['auth', 'login', '--claudeai'], {
    env: { ...process.env, BROWSER: 'true' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (spawned.status === 'failed') {
    onEvent({ type: 'error', message: spawned.reason });
    return { ok: false, reason: spawned.reason };
  }
  const child: ChildProcessWithoutNullStreams = spawned.value;

  let urlSent: string | undefined;
  let pasteReady = false;

  /**
   * One line buffer per stream. stdout and stderr interleave, and a buffer
   * shared between them splices half a line of one into the middle of a line
   * of the other — which is exactly how a URL goes missing.
   *
   * The trailing partial is re-read on every chunk because **the paste prompt
   * never ends its line** (`Paste code here if prompted > `), so waiting for a
   * newline would wait forever — but only as far as `settledPrefix`. Read raw,
   * that tail hands a half-written token over as a whole one: a URL split
   * across two chunks went out truncated and then entire, and the host opened
   * both. The prompt survives the rule, its own trailing space being the
   * boundary.
   *
   * Both facts it is read for latch — `urlSent` and `pasteReady` — and the
   * error line is deliberately not among them, since a partial grows and would
   * re-fire on every chunk.
   */
  const reader = (): ((chunk: Buffer | string) => void) => {
    let buf = '';
    return (chunk) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? '';
      for (const line of parts) handleLine(line);
      const tail = settledPrefix(buf);
      if (!urlSent) {
        const url = loginUrlFrom(tail);
        if (url) emitUrl(url);
      }
      if (!pasteReady && loginWantsPaste(tail)) {
        pasteReady = true;
        onEvent({ type: 'phase', phase: 'paste' });
      }
    };
  };

  const emitUrl = (url: string) => {
    if (urlSent === url) return;
    urlSent = url;
    onEvent({ type: 'url', url });
    onEvent({ type: 'phase', phase: 'browser' });
  };

  const handleLine = (line: string) => {
    const url = loginUrlFrom(line);
    if (url) emitUrl(url);
    if (loginWantsPaste(line)) {
      pasteReady = true;
      onEvent({ type: 'phase', phase: 'paste' });
    }
    if (/invalid code/i.test(line)) {
      onEvent({
        type: 'error',
        message: 'Invalid code. Paste the full code from the browser.'
      });
      onEvent({ type: 'phase', phase: 'paste' });
    }
  };

  child.stdout.on('data', reader());
  child.stderr.on('data', reader());
  child.on('error', (err) => {
    onEvent({ type: 'error', message: err.message });
    onEvent({ type: 'phase', phase: 'error', message: err.message });
  });
  child.on('close', (code) => {
    onEvent({ type: 'exit', code });
    if (code === 0) onEvent({ type: 'phase', phase: 'done' });
    else if (code !== null) {
      onEvent({
        type: 'phase',
        phase: 'error',
        message: 'Sign in did not finish. Try again.'
      });
    }
  });

  return {
    submit(code: string) {
      const trimmed = code.trim();
      if (!trimmed) return;
      onEvent({ type: 'phase', phase: 'waiting', message: 'Checking code…' });
      try {
        child.stdin.write(trimmed + '\n');
      } catch {
        onEvent({ type: 'error', message: 'Could not send the code to the CLI.' });
      }
    },
    cancel() {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      child.kill('SIGTERM');
    }
  };
}
