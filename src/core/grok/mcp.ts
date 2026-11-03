/**
 * Grok MCP servers: `[mcp_servers.*]` in `~/.grok/config.toml`, tokens in
 * `mcp_credentials.json`, and the ACP trigger that starts one login.
 *
 * Observed 2026-08-17, CLI 1.0.4; project scope re-checked 2026-08-20, CLI
 * 1.0.5. No `grok mcp login` / `logout` — OAuth is `_x.ai/mcp/auth_trigger
 * { session_id, server_name }`, and it is discarded unless MCP init has
 * settled first (`initSettled`, `core/grok/session.ts`). Once it takes, the
 * CLI opens the browser, binds `127.0.0.1:<port>`, and the RPC stays pending
 * until the grant. No authorize url comes back on the wire, so there is no
 * link of ours to offer. A prompt does not start OAuth. `grok mcp doctor` is
 * a network round trip and is not run here.
 *
 * Credentials are keyed `name:url`. Do not log the file. Shape:
 * `docs/reference/cli_state/grok/mcp.md`.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AcpClient } from '../acp';
import { grokBinary } from '../bin';
import * as platform from '../platform';
import { grokHome, grokMcpCredentialLock } from '../paths';
import type { McpActionRef, McpActionTarget } from '../mcp_target';
import type { McpLoginPrepared, McpRow, McpSnapshot } from '../mcp';
import { childTransport } from '../session';
import { GROK_MCP_INIT_MS, initSettled, pickAuth } from './session';

/** Where a Grok declaration lives. `grok mcp add --help`, CLI 1.0.5. */
export type GrokMcpScope = 'user' | 'project';

export type GrokMcpServer = {
  name: string;
  url: string;
  /** Empty for `user`. For `project`, the directory the file was read from. */
  project: string;
  scope: GrokMcpScope;
};

export type GrokMcpWhere = {
  project: string;
  scope: GrokMcpScope;
};

/** The wait line while Grok holds the grant. Host-composed, no surface of ours.
 *  States what was asked for rather than what happened: nothing comes back on
 *  the wire when the trigger takes, so a browser is never a fact we hold. */
export const GROK_MCP_WAIT = 'Asked Grok for the grant — it opens the browser itself.';

function unquote(raw: string): string {
  const s = raw.trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** Drop a `#` comment that is not inside quotes. */
function stripComment(line: string): string {
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== '\\') inQ = !inQ;
    else if (c === '#' && !inQ) return line.slice(0, i);
  }
  return line;
}

/**
 * `[mcp_servers.<name>]` blocks with a url. `enabled = false` is skipped.
 * Hand-rolled: the file is small and we do not take a TOML package for it.
 */
export function parseGrokMcpServers(toml: string, where?: GrokMcpWhere): GrokMcpServer[] {
  const place: GrokMcpWhere = where ?? { project: '', scope: 'user' };
  const out: GrokMcpServer[] = [];
  let name: string | undefined;
  let url: string | undefined;
  let enabled = true;

  const flush = (): void => {
    if (name && url && enabled) {
      out.push({ name, url, project: place.project, scope: place.scope });
    }
    name = undefined;
    url = undefined;
    enabled = true;
  };

  for (const raw of toml.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = line.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (header?.[1]) {
      flush();
      name = unquote(header[1]);
      continue;
    }
    if (line.startsWith('[')) {
      flush();
      continue;
    }
    if (!name) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv?.[1] || kv[2] === undefined) continue;
    const val = unquote(kv[2]);
    if (kv[1] === 'url' && val) url = val;
    if (kv[1] === 'enabled') enabled = val !== 'false';
  }
  flush();
  return out;
}

/** Credential keys that look like `name:url`. Anything else is ignored. */
export function parseGrokCredentials(text: string): Set<string> {
  const keys = new Set<string>();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return keys;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return keys;
  for (const key of Object.keys(raw)) {
    if (key.includes('://')) keys.add(key);
  }
  return keys;
}

/**
 * Same name in two `.grok/config.toml` files of one repo: the deeper file
 * replaces the shallower. Observed 2026-08-20, CLI 1.0.5 — Grok walks cwd up
 * to the git root and a project server with the same name as another project
 * one replaces it entirely, not a field merge.
 *
 * `project` is still the read path. `groupOf` is the checkout those paths
 * belong to (the host's `repoOf`). User-scope servers are not compared.
 */
export function deeperProjectWins(
  servers: readonly GrokMcpServer[],
  groupOf: (server: GrokMcpServer) => string
): GrokMcpServer[] {
  const best = new Map<string, GrokMcpServer>();
  const rest: GrokMcpServer[] = [];
  for (const server of servers) {
    if (server.scope !== 'project') {
      rest.push(server);
      continue;
    }
    const key = groupOf(server) + '\0' + server.name;
    const seen = best.get(key);
    if (!seen || deeperPath(server.project, seen.project)) best.set(key, server);
  }
  return [...best.values(), ...rest];
}

/** True when `a` is under `b`, or neither nests and `a` is the longer path. */
function deeperPath(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith(b.endsWith('/') ? b : b + '/')) return true;
  if (b.startsWith(a.endsWith('/') ? a : a + '/')) return false;
  return a.length >= b.length;
}

/** A present `name:url` key is ok — the same lie Claude's cache already tells. */
export function grokMcpRows(
  servers: readonly GrokMcpServer[],
  creds: ReadonlySet<string>
): McpRow[] {
  const byIdentity = new Map<string, McpRow>();
  for (const server of servers) {
    const identity = server.scope + '\0' + server.name + '\0' + server.url;
    const seen = byIdentity.get(identity);
    const ref: McpActionRef = {
      brand: 'grok',
      name: server.name,
      key: server.url,
      url: server.url,
      declaration:
        server.scope === 'user' ? { scope: 'user' } : { scope: server.scope, root: server.project },
      readCwd: server.project || os.homedir()
    };
    const declaration = { sectionRoot: server.project, ref };
    const project = path.basename(server.project);
    const entry = server.project ? [{ root: server.project, scope: server.scope }] : [];
    if (seen) {
      if (project && !seen.projects.includes(project)) seen.projects.push(project);
      seen.entries.push(...entry);
      seen.declarations?.push(declaration);
      continue;
    }
    byIdentity.set(identity, {
      declarations: [declaration],
      brand: 'grok',
      canLogin: true,
      // Grok stores every one of these itself, keyed `name:url`, so a row it
      // reports connected is ours to take back — and one it does not is a login
      // waiting to be started, not a credential waiting to be removed.
      canDisconnect: creds.has(`${server.name}:${server.url}`),
      name: server.name,
      key: server.url,
      url: server.url,
      host: hostOf(server.url),
      projects: project ? [project] : [],
      entries: entry,
      state: creds.has(`${server.name}:${server.url}`) ? 'ok' : 'needs'
    });
  }
  return [...byIdentity.values()];
}

export function grokMcpSnapshot(opts: {
  roots: readonly string[];
  userConfig?: string;
  projectByRoot: Readonly<Record<string, string | undefined>>;
  credentials?: string;
}): McpSnapshot {
  const roots = [...new Set(opts.roots)];
  const servers = deeperProjectWins(
    [
      ...roots.flatMap((root) => {
        const text = opts.projectByRoot[root];
        return text ? parseGrokMcpServers(text, { project: root, scope: 'project' }) : [];
      }),
      ...(opts.userConfig ? parseGrokMcpServers(opts.userConfig) : [])
    ],
    (server) => server.project
  );
  return {
    opensBoard:
      opts.userConfig !== undefined || roots.some((root) => opts.projectByRoot[root] !== undefined),
    rows: grokMcpRows(servers, parseGrokCredentials(opts.credentials ?? '{}'))
  };
}

export async function readGrokMcp(opts: { roots: readonly string[] }): Promise<McpSnapshot> {
  const paths = await import('../paths');
  const roots = [...new Set(opts.roots)];
  const [userConfig, credentials, projects] = await Promise.all([
    fs.readFile(paths.GROK_CONFIG_FILE, 'utf8').catch(() => undefined),
    fs.readFile(paths.GROK_MCP_CREDENTIALS_FILE, 'utf8').catch(() => undefined),
    Promise.all(
      roots.map(
        async (root) =>
          [
            root,
            await fs
              .readFile(path.join(root, '.grok', 'config.toml'), 'utf8')
              .catch(() => undefined)
          ] as const
      )
    )
  ]);
  return grokMcpSnapshot({
    ...opts,
    userConfig,
    credentials,
    projectByRoot: Object.fromEntries(projects)
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const CREDENTIAL_LOCK_ATTEMPTS = 9;
const CREDENTIAL_LOCK_WAIT_MS = 25;

type CredentialClaim = {
  attemptId: string;
  lockHandle?: fs.FileHandle;
  lockPath?: string;
  tempHandle?: fs.FileHandle;
  tempPath?: string;
};

/**
 * Drop one `name:url` key. Grok has no `mcp logout` (1.0.4). The re-read is
 * the report, same as Claude's logout.
 */
export async function grokMcpLogout(target: McpActionTarget, home?: string): Promise<void> {
  if (!target.url) return;
  const claim: CredentialClaim = { attemptId: randomUUID() };
  let failure: unknown;
  try {
    if (!(await claimCredentialLock(claim, home)) || !claim.lockHandle) return;
    await claim.lockHandle.writeFile(
      JSON.stringify({ pid: process.pid, attemptId: claim.attemptId })
    );
    await publishCredentialRemoval(target, home, claim);
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = await releaseCredentialClaim(claim);
    reportCredentialFailure(failure, cleanup);
  }
}

/**
 * Ownership is the exclusive create. An empty, malformed, live or orphan lock
 * is occupied: this call does not parse it, probe a pid, or unlink it.
 * Removing one takes quiescing every writer outside this function.
 */
async function claimCredentialLock(claim: CredentialClaim, home?: string): Promise<boolean> {
  const lockPath = grokMcpCredentialLock(home);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < CREDENTIAL_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const lockHandle = await fs.open(lockPath, 'wx', 0o600);
      claim.lockHandle = lockHandle;
      claim.lockPath = lockPath;
      return true;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      if (attempt === CREDENTIAL_LOCK_ATTEMPTS - 1) return false;
      await new Promise((resolve) => setTimeout(resolve, CREDENTIAL_LOCK_WAIT_MS));
    }
  }
  return false;
}

/**
 * The Grok CLI writes this file without this lock. Its rename can drop a new
 * token or restore a deleted key. Grok 1.0.70 strings suggest a stale-save
 * guard; they do not establish a protocol this process can join.
 */
async function publishCredentialRemoval(
  target: McpActionTarget,
  home: string | undefined,
  claim: CredentialClaim
): Promise<void> {
  const file = path.join(grokHome(home), 'mcp_credentials.json');
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const key = `${target.name}:${target.url}`;
  if (!(key in raw)) return;
  const next = { ...(raw as Record<string, unknown>) };
  delete next[key];
  const tmp = `${file}.${process.pid}.${claim.attemptId}.tmp`;
  const tempHandle = await fs.open(tmp, 'wx', 0o600);
  claim.tempHandle = tempHandle;
  claim.tempPath = tmp;
  await tempHandle.writeFile(JSON.stringify(next, null, 2));
  await tempHandle.close();
  claim.tempHandle = undefined;
  await platform.files.replace(tmp, file, { kind: 'owned', legacyRetry: 'grok-mcp-credentials' });
}

async function releaseCredentialClaim(claim: CredentialClaim): Promise<unknown[]> {
  const cleanup: unknown[] = [];
  if (claim.tempHandle) {
    try {
      await claim.tempHandle.close();
    } catch (error) {
      cleanup.push(error);
    }
    claim.tempHandle = undefined;
  }
  if (claim.tempPath) {
    try {
      await fs.rm(claim.tempPath, { force: true });
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (claim.lockHandle) {
    try {
      await claim.lockHandle.close();
    } catch (error) {
      cleanup.push(error);
    }
    claim.lockHandle = undefined;
  }
  if (claim.lockPath) {
    try {
      await fs.unlink(claim.lockPath);
    } catch (error) {
      cleanup.push(error);
    }
  }
  return cleanup;
}

function reportCredentialFailure(failure: unknown, cleanup: readonly unknown[]): void {
  if (failure === undefined && cleanup.length === 0) return;
  if (failure instanceof Error && cleanup.length === 0) throw failure;
  if (failure === undefined && cleanup.length === 1 && cleanup[0] instanceof Error)
    throw cleanup[0];
  const problems = (failure === undefined ? [...cleanup] : [failure, ...cleanup]).map((item) =>
    item instanceof Error ? item : new Error('credential publish failed', { cause: item })
  );
  const only = problems.length === 1 ? problems[0] : undefined;
  if (only) throw only;
  throw new AggregateError(problems, 'credential publish failed');
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** Hold until `init_progress` says every server has been attempted, or the cap
 *  runs out. Never rejects: a cap that fires is a trigger worth trying anyway. */
function settled(client: AcpClient, capMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, capMs);
    const off = client.onNotification((method, params) => {
      if (method === '_x.ai/mcp/init_progress' && initSettled(params)) finish();
    });
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/**
 * Disposable `grok agent stdio` that fires `auth_trigger` and exits.
 *
 * ACP cannot prove the declaration loaded by an existing session. Each
 * explicit authorisation uses this child at the validated declaration cwd.
 */
export async function prepareGrokMcpLogin(opts: {
  target: McpActionTarget;
  binOverride?: string;
}): Promise<McpLoginPrepared | { ok: false; reason: string }> {
  const bin = await grokBinary(opts.binOverride);
  if (!bin.ok) return { ok: false, reason: bin.reason };

  try {
    const { stdout } = await platform.executables.exec(bin.program, ['mcp', 'list', '--json'], {
      cwd: opts.target.readCwd,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024
    });
    const rows: unknown = JSON.parse(stdout);
    const matches = Array.isArray(rows)
      ? rows.filter(
          (r: unknown) =>
            !!r && typeof r === 'object' && (r as { name?: unknown }).name === opts.target.name
        )
      : [];
    const row =
      matches.length === 1
        ? (matches[0] as { url?: unknown; scope?: unknown; enabled?: unknown })
        : undefined;
    if (
      !row ||
      row.url !== opts.target.url ||
      row.scope !== opts.target.declaration.scope ||
      row.enabled === false
    )
      throw new Error('MCP declaration changed; reopen MCP and try again.');
  } catch {
    return {
      ok: false,
      reason: 'MCP declaration changed or could not be checked. Reopen MCP and try again.'
    };
  }
  return {
    start(onEvent) {
      onEvent({ type: 'phase', phase: 'starting' });

      const transport = childTransport({
        bin: bin.program,
        cwd: opts.target.readCwd,
        args: ['agent', '--no-leader', '--always-approve', 'stdio'],
        env: { HOME: os.homedir() }
      });
      const client = new AcpClient(transport);
      let cancelled = false;
      const abort = new AbortController();

      const fail = (message: string): void => {
        if (cancelled) return;
        onEvent({ type: 'error', message });
        onEvent({ type: 'phase', phase: 'error', message });
      };

      const run = async (): Promise<void> => {
        try {
          const hello = await client.initialize({
            protocolVersion: 1,
            clientInfo: { name: 'squadron', version: '0' },
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
          });
          const methodId = pickAuth(hello);
          if (!methodId) {
            fail('Grok has no non-interactive sign-in available.');
            return;
          }
          await client.request('authenticate', { methodId });
          const init = settled(client, GROK_MCP_INIT_MS, abort.signal);
          const created = await client.request('session/new', {
            cwd: opts.target.readCwd,
            mcpServers: []
          });
          const sessionId =
            created &&
            typeof created === 'object' &&
            !Array.isArray(created) &&
            typeof (created as { sessionId?: unknown }).sessionId === 'string'
              ? (created as { sessionId: string }).sessionId
              : undefined;
          if (!sessionId) {
            fail('Grok did not open a session.');
            return;
          }
          if (cancelled) return;
          // **Do not fire this any earlier.** Measured 2026-08-17, CLI 1.0.4: a
          // trigger sent as soon as `session/new` returns is discarded — no
          // browser, no `127.0.0.1:<port>` listener, and the RPC never resolves, so
          // the reader waits on a grant that was never started. The same trigger
          // once init has settled binds the port and opens the browser.
          await init;
          if (cancelled) return;
          onEvent({ type: 'phase', phase: 'waiting', message: GROK_MCP_WAIT });
          await client.request('_x.ai/mcp/auth_trigger', {
            session_id: sessionId,
            server_name: opts.target.name
          });
          if (cancelled) return;
          onEvent({ type: 'phase', phase: 'done' });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Authorisation did not finish.';
          fail(message);
        } finally {
          abort.abort();
          transport.close();
        }
      };

      void run();
      return {
        cancel() {
          cancelled = true;
          abort.abort();
          transport.close();
        }
      };
    }
  };
}
