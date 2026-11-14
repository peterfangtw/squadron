/**
 * Machine-wide Grok authentication: status off `auth.json`, logout, and the
 * device-code login child.
 *
 * Status is the file, not a spawn. Observed 2026-08-16 (CLI 1.0.4): missing
 * or empty `~/.grok/auth.json` is signed out; an empty credential map is also
 * signed out (1.0.77, 2026-11-14). Email is nested under
 * `https://auth.x.ai::<client-id>`, never top-level. Never log the file.
 *
 * Login is `grok login --device-auth`. Piped, it prints a URL and a
 * `XXXX-XXXX` user code on stderr, then waits. stdout is empty. `--oauth`
 * binds a localhost callback — do not use it. Brand spelling stays here.
 */

import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { settledPrefix, type LoginEvent, type LoginSession } from '../accounts';
import { grokBinary } from '../bin';
import * as platform from '../platform';
import * as files from '../files';
import { grokHome, grokRefreshLock, grokRefreshLockDir, isGrokRefreshLock } from '../paths';
import { scanProcesses, type ProcessTable } from '../scan';

/** Same budget as Claude's spawn — copy the number, do not import Claude's. */
const SPAWN_MS = 4000;

/**
 * **No plan, on purpose.** The row's chip is `plan` on the account status, and
 * this brand states nothing to put in it: probed 2026-09-01, `auth.json` has no
 * plan or subscription field anywhere in it, and the only thing resembling one
 * is a `tier: 1` claim inside the bearer, which names no tier and has been seen
 * on exactly one account. The billing body (`grok/usage.ts`) may carry a plan
 * and is the place to look first. Reading it needs a live bearer, which since
 * `refreshGrokBearer` no longer means a live Grok session is worth trying.
 */
export type GrokAuthStatus = {
  loggedIn: boolean;
  email?: string;
};

/** First non-empty string field `name` anywhere in the object. */
function firstStringNamed(value: unknown, name: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstStringNamed(item, name);
      if (found) return found;
    }
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  const own = rec[name];
  if (typeof own === 'string' && own.trim()) return own.trim();
  for (const child of Object.values(rec)) {
    const found = firstStringNamed(child, name);
    if (found) return found;
  }
  return undefined;
}

/** First string `email` anywhere in the object. Tokens stay in the file. */
function emailIn(value: unknown): string | undefined {
  return firstStringNamed(value, 'email');
}

/**
 * One credential entry, read as a unit.
 *
 * Observed 2026-08-16 (CLI 1.0.4): `auth.json` is one top-level
 * `https://auth.x.ai::<client-id>` key over an object holding `key`,
 * `refresh_token`, `expires_at`, `oidc_issuer`, `oidc_client_id`, and identity
 * fields. `record` is that object verbatim, because a write-back has to carry
 * back every field it did not set — including ones a later CLI adds.
 */
export type GrokCredential = {
  name: string;
  record: Record<string, unknown>;
  /** Every top-level entry, so a write-back replaces one and keeps the rest. */
  whole: Record<string, unknown>;
  key: string;
  refreshToken?: string;
  clientId?: string;
  expiresAt?: number;
};

/** What the billing GET needs, and nothing that could rotate. */
export type GrokBearer = { key: string; expiresAt?: number };

/** `exp` out of a JWT bearer, unverified — this schedules a refresh, it does
 *  not authorize anything. Not a JWT (the opaque case) states no expiry. */
function jwtExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') return undefined;
    const exp = (claims as Record<string, unknown>).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The first top-level entry that states a bearer, with every field taken from
 * that same entry.
 *
 * **Not a recursive first-match per field**, which is what `emailIn` still
 * does: with two entries on disk, walking for `key` and `refresh_token`
 * separately can pair one account's bearer with another's refresh token, and
 * spending that mismatched pair is how a refresh signs the reader out.
 */
function readCredential(raw: unknown): GrokCredential | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const key = record.key;
    if (typeof key !== 'string' || !key.trim()) continue;

    const stated = record.expires_at;
    let expiresAt: number | undefined;
    if (typeof stated === 'string') {
      const ms = Date.parse(stated);
      if (Number.isFinite(ms)) expiresAt = ms;
    }
    expiresAt ??= jwtExpiry(key.trim());

    const refreshToken = record.refresh_token;
    const clientId = record.oidc_client_id;
    return {
      name,
      record,
      whole: raw as Record<string, unknown>,
      key: key.trim(),
      ...(typeof refreshToken === 'string' && refreshToken.trim()
        ? { refreshToken: refreshToken.trim() }
        : {}),
      ...(typeof clientId === 'string' && clientId.trim() ? { clientId: clientId.trim() } : {}),
      ...(expiresAt === undefined ? {} : { expiresAt })
    };
  }
  return undefined;
}

/** Parse `auth.json`, or nothing. Missing / empty / unreadable / malformed →
 *  undefined, not throw. Never log the file. */
async function readCredentialFile(home?: string): Promise<GrokCredential | undefined> {
  const file = path.join(grokHome(home), 'auth.json');
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0) return undefined;
    return readCredential(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Bearer for the billing GET, with the expiry that decides whether it is worth
 * sending. Refresh material stays behind this read — usage never sees it.
 */
export async function grokAccessToken(home?: string): Promise<GrokBearer | undefined> {
  const credential = await readCredentialFile(home);
  return credential ? bearerOf(credential) : undefined;
}

/**
 * How long one token exchange may take.
 *
 * A minute, not the few seconds a UI fetch gets. Giving up early does not
 * cancel a request xAI has already acted on — it only turns a slow success into
 * the unrecoverable case, where the token on disk is spent and we never saw the
 * replacement. Waiting costs one stale poll.
 */
export const REFRESH_MS = 60_000;

/**
 * Allowlisted, never composed from the `oidc_issuer` on disk: a malformed or
 * replaced auth file must not make us POST a refresh token to another origin.
 */
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';

/** The POST this needs, narrowed to what it uses. Separate from `GrokFetch` in
 *  `usage.ts`, which cannot express a body, a content type, or a signal. */
export type GrokTokenFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** A bearer with no stated expiry is used as it stands and never refreshed: an
 *  unknown clock must not become a token POST every poll. Exported because
 *  `usage.ts` asks the same question of the same field, and two copies of it
 *  both compile while they drift. */
export function unexpired(bearer: { expiresAt?: number }): boolean {
  return bearer.expiresAt === undefined || bearer.expiresAt > Date.now();
}

function bearerOf(credential: GrokCredential): GrokBearer {
  return {
    key: credential.key,
    ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt })
  };
}

const fingerprintOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 16);

/**
 * The CLI's own spelling of an instant: six fractional digits and a `+00:00`
 * offset, as observed on disk — not `toISOString()`, which writes three and a
 * `Z`. A credential the Grok CLI cannot deserialize is a sign-out by a longer
 * route than the one this whole module is careful about.
 */
function stampExpiry(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, -1)}000+00:00`;
}

type Renewed = { key: string; expiresAt: number; refreshToken?: string };

/** Narrow a token response. No *future* expiry is no evidence — writing one
 *  would schedule the next refresh off a guess. */
function readTokenResponse(body: unknown): Renewed | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const rec = body as Record<string, unknown>;
  const access = rec.access_token;
  if (typeof access !== 'string' || !access.trim()) return undefined;
  const key = access.trim();

  const seconds = rec.expires_in;
  let expiresAt: number | undefined;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    expiresAt = Date.now() + seconds * 1000;
  }
  expiresAt ??= jwtExpiry(key);
  if (expiresAt === undefined || expiresAt <= Date.now()) return undefined;

  const rotated = rec.refresh_token;
  return {
    key,
    expiresAt,
    ...(typeof rotated === 'string' && rotated.trim() ? { refreshToken: rotated.trim() } : {})
  };
}

/**
 * Drop markers for tokens the credential no longer states.
 *
 * **Housekeeping only, and deliberately not on the path to a POST.** A marker
 * is the one thing stopping a possibly-spent token from being replayed, so a
 * sweep running while another window is mid-flight can delete exactly the guard
 * that matters — and the fingerprint a caller holds before its process scan is
 * precisely the value it has not yet re-validated against disk. So this runs
 * only after a successful write-back, and keeps whatever the credential states
 * when it looks: a marker for the current token is somebody's live attempt.
 *
 * It has to run somewhere. `prune.ts` never touches `STATE_DIR`'s top
 * (`paths.ts:95`), so an abandoned marker would otherwise be immortal.
 */
async function sweepStaleLocks(home?: string): Promise<void> {
  const settled = await readCredentialFile(home);
  // No readable refresh token is not evidence that every marker is stale. This
  // runs immediately after our own write-back, so the file is there and a read
  // that fails here is transient — sweeping on it would delete markers with
  // nothing to compare them against, which is the one thing this must not do.
  if (!settled?.refreshToken) return;
  const keep = grokRefreshLock(fingerprintOf(settled.refreshToken), home);
  const dir = grokRefreshLockDir(home);
  try {
    for (const name of await fs.readdir(dir)) {
      const full = path.join(dir, name);
      if (isGrokRefreshLock(name) && full !== keep) {
        await fs.rm(full, { force: true }).catch(() => {});
      }
    }
  } catch {
    /* no state directory yet — nothing to sweep */
  }
}

/** The post-exchange read, retried. Same reasoning as the rename below: past
 *  the POST, "could not read" and "somebody else won" have opposite correct
 *  responses, and only the second one is evidence. */
async function readAfterSend(home?: string): Promise<GrokCredential | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const found = await readCredentialFile(home);
    if (found) return found;
    if (attempt < 3) await new Promise((wait) => setTimeout(wait, 25 * (attempt + 1)));
  }
  return undefined;
}

/**
 * Replace at most three fields of one entry and rename the result into place.
 *
 * Not `writeAtomicJson`: its temp is created at the default mode, so it would
 * hand back a `0644` credential where the CLI wrote `0600`.
 *
 * A failed save leaves the spent-token marker in place; another refresh cannot
 * recover a disk failure without risking reuse of the token already exchanged.
 *
 * A crash between the write and the rename strands a temp holding the *new*
 * refresh token. It is `0600` like the credential beside it, and nothing here
 * sweeps `~/.grok` — that directory is the CLI's, and deleting another
 * program's files to tidy up ours is the worse trade.
 */
async function writeCredentialFile(
  current: GrokCredential,
  renewed: Renewed,
  home?: string
): Promise<boolean> {
  const named = path.join(grokHome(home), 'auth.json');
  // Follow a dotfile manager's symlink instead of replacing it with a regular
  // file, which is what renaming over the link itself would do.
  let file = named;
  try {
    file = await fs.realpath(named);
  } catch {
    /* not a link, or already gone; the write below reports either */
  }

  const body = JSON.stringify({
    ...current.whole,
    [current.name]: {
      ...current.record,
      key: renewed.key,
      expires_at: stampExpiry(renewed.expiresAt),
      ...(renewed.refreshToken ? { refresh_token: renewed.refreshToken } : {})
    }
  });

  const tmp = `${file}.${process.pid}.0.tmp`;
  try {
    await fs.writeFile(tmp, body, { flag: 'wx', mode: 0o600 });
    await platform.files.replace(tmp, file);
    return true;
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}

/**
 * Codes that prove no request bytes ever left this machine: name resolution,
 * routing, and a refused connect.
 *
 * `ECONNRESET`, `ETIMEDOUT` and every TLS failure are deliberately absent. Each
 * can land after the request went out, and a token that may have reached xAI is
 * the ambiguous case — the marker stays.
 */
const NEVER_SENT = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN'
]);

/**
 * Whether a rejected `fetch` proves the refresh token is still unspent.
 *
 * `fetch` rejects with a bare `TypeError`, so the code is on `cause` — and on
 * an `AggregateError` there, because undici tries A and AAAA and reports both.
 * Every leg has to have failed this way: one that got further is a token that
 * may have been seen.
 */
function neverLeftTheMachine(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  if (!cause || typeof cause !== 'object') return false;
  const legs = (cause as { errors?: unknown }).errors;
  const all = Array.isArray(legs) && legs.length > 0 ? legs : [cause];
  return all.every((one) => {
    const code = (one as { code?: unknown } | null | undefined)?.code;
    return typeof code === 'string' && NEVER_SENT.has(code);
  });
}

/**
 * Renew the bearer with one OAuth POST, or return nothing and change no state.
 *
 * **The refresh token rotates on use**, so this is not an ordinary read that can
 * be retried. Once the request has left the machine a lost reply is
 * indistinguishable from a success we did not see, and the token on disk may
 * already be spent. Replaying it risks the provider revoking the whole family,
 * so it is never sent twice: the lock file is keyed by the token's fingerprint
 * and is deliberately *not* removed on an ambiguous failure. A Grok CLI run or
 * a re-login is what supplies a token that can be tried again.
 *
 * Everything that can be checked is checked before the lock is claimed, so that
 * the window in which a crash is indistinguishable from a spent token is one
 * `fetch` wide. Order matters more than any single guard here — including that
 * nothing *deletes* a marker before the POST, which is why the sweep runs only
 * after a clean write-back.
 *
 * Rejected: a record holding an owner pid and a phase — marking a phase then
 * re-reading it is write-then-read, and the write erases the takeover it is
 * meant to detect.
 */
export async function refreshGrokBearer(opts?: {
  home?: string;
  fetch?: GrokTokenFetch;
  scan?: () => Promise<ProcessTable>;
  /** The abort budget. Only a test passes it — waiting out `REFRESH_MS` is the
   *  one thing that makes the timeout path untestable. */
  budgetMs?: number;
}): Promise<GrokBearer | undefined> {
  const home = opts?.home;
  const credential = await readCredentialFile(home);
  if (!credential) return undefined;
  // Another window may have renewed while this poll sat in the queue. Asked
  // before the refresh material is: a key good enough to send is worth handing
  // back whether or not this credential could have renewed it.
  if (unexpired(credential)) return bearerOf(credential);
  if (!credential.refreshToken || !credential.clientId) return undefined;

  const table = await (opts?.scan ?? ((): Promise<ProcessTable> => scanProcesses(true)))();
  // An empty table is a failed read, not a quiet machine (`scan.ts`
  // `tableCache`), and an incomplete one may have left out the very row that
  // is a running grok (a Windows row whose start will not convert is dropped).
  // "Cannot prove none" is not good enough to risk the credential on.
  if (!table.complete || table.parents.size === 0 || table.grok.size > 0) return undefined;

  const lock = grokRefreshLock(fingerprintOf(credential.refreshToken), home);
  try {
    // Contents are for a human reading the file; nothing parses them, and
    // nothing may — a record that gets re-read is the design rejected above.
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await fs.writeFile(lock, JSON.stringify({ at: new Date().toISOString(), pid: process.pid }), {
      flag: 'wx',
      mode: 0o600
    });
  } catch {
    // Someone owns this token's one attempt. If they have already finished,
    // their bearer is on disk and there is no reason to paint nothing for
    // another five minutes.
    const settled = await readCredentialFile(home);
    return settled && unexpired(settled) ? bearerOf(settled) : undefined;
  }

  // **Compare after claiming, never before.** The create is the linearization
  // point, not any read above it: another window can finish its whole exchange
  // between our read and our claim, and its clean write-back takes away the
  // marker that would otherwise have refused us — leaving us holding a fresh
  // guard over a token it has already spent. Nothing has been sent yet, so this
  // marker is ours to withdraw.
  const before = await readCredentialFile(home);
  if (before?.refreshToken !== credential.refreshToken) {
    await fs.rm(lock, { force: true }).catch(() => {});
    // Whoever moved it has written their bearer; hand that back rather than
    // paint nothing for another five minutes over a renewal that succeeded.
    return before && unexpired(before) ? bearerOf(before) : undefined;
  }

  // Past this line the token may have reached xAI, so no failure removes the
  // lock — every early return below is deliberately leaving it in place.
  const send = opts?.fetch ?? ((url, init) => fetch(url, init));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts?.budgetMs ?? REFRESH_MS);
  let body: unknown;
  try {
    const res = await send(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
        client_id: credential.clientId
      }).toString(),
      signal: abort.signal
    });
    if (!res.ok) {
      // Drain it: an unread body holds the connection open until GC, and a
      // persistent `invalid_grant` takes this branch on every poll.
      await res.json().catch(() => undefined);
      return undefined;
    }
    body = await res.json();
  } catch (error) {
    // The one failure past the claim that is *not* ambiguous. Nothing sweeps a
    // marker except a later successful write-back, so keeping this one would
    // disable renewal for this token until a Grok CLI run rotates it — which is
    // the frozen chip this whole module exists to end, now silent and permanent
    // because a laptop was offline for the one poll that mattered.
    if (neverLeftTheMachine(error)) await fs.rm(lock, { force: true }).catch(() => {});
    return undefined;
  } finally {
    clearTimeout(timer);
  }

  const renewed = readTokenResponse(body);
  if (!renewed) return undefined;

  // A changed record means a CLI or a logout won while we waited; discard our
  // response rather than overwrite their state. But a read that *fails* is not
  // that — and `renewed` is by now the only copy of a credential whose
  // predecessor is already dead, so believing a transient EMFILE or a file
  // caught mid-rewrite would sign the reader out to save nothing.
  const after = await readAfterSend(home);
  if (!after || after.name !== credential.name || after.refreshToken !== credential.refreshToken) {
    return undefined;
  }

  if (!(await writeCredentialFile(after, renewed, home))) return undefined;
  await fs.rm(lock, { force: true }).catch(() => {});
  await sweepStaleLocks(home);
  return { key: renewed.key, expiresAt: renewed.expiresAt };
}

/** The file `grokAuthStatus` reads, fingerprinted without reading it. */
export function grokAuthStamp(home?: string): Promise<string> {
  return files.fileStamp(path.join(grokHome(home), 'auth.json'));
}

export async function grokAuthStatus(home?: string): Promise<GrokAuthStatus> {
  const file = path.join(grokHome(home), 'auth.json');
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0) return { loggedIn: false };
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return { loggedIn: true };
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) {
      return { loggedIn: false };
    }
    const email = emailIn(raw);
    return email ? { loggedIn: true, email } : { loggedIn: true };
  } catch {
    return { loggedIn: false };
  }
}

export async function grokPreflight(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const status = await grokAuthStatus();
  return status.loggedIn ? { ok: true } : { ok: false, reason: 'Grok is not signed in.' };
}

/**
 * Pull the device URL and user code out of a login stderr chunk.
 *
 * Observed 2026-08-16: labelled "open this URL" line, path `/oauth2/device`,
 * `user_code=` on the URL, and a `XXXX-XXXX` line after "Confirm this code".
 * The dim "Don't share" line is ANSI; strip it so a code cannot hide in it.
 */
export function parseDeviceAuth(text: string): { url?: string; userCode?: string } {
  const cleaned = text.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
  let url: string | undefined;
  const labeled = cleaned.match(/(?:visit|open|browser)[:\s]+(https:\/\/[^\s'"<>]+)/i);
  if (labeled?.[1]) url = labeled[1];
  if (!url) {
    const links = cleaned.match(/https:\/\/[^\s'"<>]+\/oauth2\/device[^\s'"<>]*/g) ?? [];
    url = links[0];
  }
  let userCode: string | undefined;
  const fromUrl = url?.match(/[?&]user_code=([A-Z0-9-]+)/i);
  if (fromUrl?.[1]) userCode = fromUrl[1];
  if (!userCode) {
    const after = cleaned.match(/Confirm this code[^\n]*\n\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
    if (after?.[1]) userCode = after[1];
  }
  return { ...(url ? { url } : {}), ...(userCode ? { userCode } : {}) };
}

export async function grokAuthLogout(
  override?: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const bin = await grokBinary(override);
  if (!bin.ok) return { ok: false, reason: bin.reason };
  try {
    // Same HOME status reads. An Electron child that lost $HOME would
    // unlink the login user's `auth.json` instead of the one we polled.
    await platform.executables.exec(bin.program, ['logout'], {
      timeout: SPAWN_MS,
      maxBuffer: 64 * 1024,
      env: { ...process.env, HOME: os.homedir() }
    });
    return { ok: true };
  } catch (error) {
    const failed = error as { message?: string; stderr?: string; killed?: boolean };
    if (failed.killed) return { ok: false, reason: 'Logout timed out.' };
    const detail = (failed.stderr || failed.message || 'logout failed').trim();
    return { ok: false, reason: detail.slice(0, 200) };
  }
}

/**
 * Start the Grok device-code login. Emits URL + userCode, then waits.
 *
 * **The CLI opens the browser through LaunchServices**, so it reads neither
 * `$BROWSER` nor `PATH` and nothing here can suppress it — the `BROWSER=true`
 * this used to set was dead. Witness: `docs/reference/cli_state/grok/auth.md`.
 *
 * `submit` is a no-op — there is no paste.
 */
export async function startGrokLogin(
  onEvent: (event: LoginEvent) => void,
  override?: string
): Promise<LoginSession | { ok: false; reason: string }> {
  const bin = await grokBinary(override);
  if (!bin.ok) return { ok: false, reason: bin.reason };

  onEvent({ type: 'phase', phase: 'starting' });

  const spawned = platform.executables.spawn(bin.program, ['login', '--device-auth'], {
    env: { ...process.env, HOME: os.homedir() },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (spawned.status === 'failed') {
    onEvent({ type: 'error', message: spawned.reason });
    return { ok: false, reason: spawned.reason };
  }
  const child: ChildProcessWithoutNullStreams = spawned.value;

  let urlSent: string | undefined;
  let codeSent: string | undefined;

  // Whole buffer, not line-by-line: the URL sits on the line after
  // "open this URL", and the code sits on the line after "Confirm this code".
  // Its settled prefix, though — a token at the buffer's edge may be half
  // written, and this CLI's URL carries the `user_code`, so reading one early
  // loses the code with it.
  const reader = (): ((chunk: Buffer | string) => void) => {
    let buf = '';
    return (chunk) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const found = parseDeviceAuth(settledPrefix(buf));
      if (found.url && urlSent !== found.url) {
        urlSent = found.url;
        codeSent = found.userCode;
        onEvent({
          type: 'url',
          url: found.url,
          ...(found.userCode ? { userCode: found.userCode } : {})
        });
        onEvent({ type: 'phase', phase: 'waiting' });
      } else if (found.userCode && codeSent !== found.userCode && urlSent) {
        codeSent = found.userCode;
        onEvent({ type: 'url', url: urlSent, userCode: found.userCode });
      }
    };
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
    submit() {
      /* device-code: nothing to paste */
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
