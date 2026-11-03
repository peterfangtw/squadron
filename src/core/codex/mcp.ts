/**
 * Codex MCP servers: `codex mcp list --json`, and the two verbs beside it.
 *
 * Observed 2026-09-04, CLI 0.151.0. One bounded child answers configuration
 * *and* credential state together, which is why nothing here talks to the
 * app-server — that surface is experimental, needs two calls for the same
 * facts, and returns plugin tool schemas with them. Contract, the whole
 * `auth_status` enum, and the trust rule:
 * `docs/reference/cli_state/codex/mcp.md`.
 *
 * **Nothing below lets a command line onto a row.** `args`, `env`, `env_vars`
 * and the header fields name or carry secrets, and a row is drawn.
 */

import { type ChildProcessByStdio } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { codexBinary } from '../bin';
import * as platform from '../platform';
// The one thing borrowed across a brand seam, and deliberately: an authorize
// url carrying `code_challenge` is OAuth's spelling, not Claude's, and the
// chunk-boundary rule it encodes — never latch a url without its terminator —
// cost two bugs to get right there. Codex's own vocabulary stays in this file.
import { mcpAuthUrlFrom } from '../claude/mcp';
import type { McpActionTarget } from '../mcp_target';
import type { McpLoginPrepared, McpRow, McpSnapshot } from '../mcp';

/** Local work — the cap only ever catches a hang. */
const LIST_MS = 15_000;

/**
 * One `codex mcp list --json` run, as the tests replace it.
 *
 * Injected rather than mocking `execFile`, so a test states what the CLI said
 * at a cwd and nothing else has to be true.
 */
export type CodexMcpRunner = (args: readonly string[], cwd: string) => Promise<string>;

/**
 * `auth_status`, verbatim. Five values; `o_auth` is the one that spells itself
 * unexpectedly and the only one that owns a credential we can remove.
 */
type CodexAuthStatus = 'unknown' | 'not_logged_in' | 'o_auth' | 'bearer_token' | 'unsupported';

type CodexMcpServer = {
  name: string;
  enabled: boolean;
  disabledReason?: string;
  /** Absent for STDIO, which is the whole reason a row needs a key. */
  url?: string;
  /** Basename only. The rest of the command line does not leave this file. */
  command?: string;
  auth: CodexAuthStatus;
};

/** Everything a cell needs, and nothing a secret could ride in on. */
function narrow(value: unknown): CodexMcpServer | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const said = value as Record<string, unknown>;
  const name = said.name;
  if (typeof name !== 'string' || !name) return undefined;
  const transport = (said.transport ?? {}) as Record<string, unknown>;
  const url = typeof transport.url === 'string' ? transport.url : undefined;
  const command = typeof transport.command === 'string' ? transport.command : undefined;
  const reason = said.disabled_reason;
  return {
    name,
    enabled: said.enabled !== false,
    ...(typeof reason === 'string' && reason ? { disabledReason: reason } : {}),
    ...(url ? { url } : {}),
    ...(command ? { command: path.basename(command) } : {}),
    auth: authOf(said.auth_status)
  };
}

/** An unrecognised value is `unknown`. A guess here paints a wrong button. */
function authOf(value: unknown): CodexAuthStatus {
  return value === 'not_logged_in' ||
    value === 'o_auth' ||
    value === 'bearer_token' ||
    value === 'unsupported'
    ? value
    : 'unknown';
}

async function listAt(cwd: string, exec: CodexMcpRunner): Promise<CodexMcpServer[] | undefined> {
  try {
    const parsed: unknown = JSON.parse(await exec(['mcp', 'list', '--json'], cwd));
    if (!Array.isArray(parsed)) return undefined;
    return parsed.map(narrow).filter((s): s is CodexMcpServer => !!s);
  } catch {
    // A missing binary, a non-zero exit, or output that is not the array we
    // expect. The caller leaves that scope out rather than emptying the sheet.
    return undefined;
  }
}

/**
 * A row's identity.
 *
 * An HTTP row keys by url so it joins Claude's and Grok's rows for the same
 * server. A STDIO row has no url and must not borrow its command line for one,
 * so it keys on where it was declared — which also keeps two projects' `pencil`
 * apart, correctly: they are two processes.
 */
const keyOf = (server: CodexMcpServer, root: string): string =>
  server.url ?? `codex|${root}|${server.name}`;

/**
 * What a cell has room for. A STDIO row says its transport and the program,
 * because the host slot is where a reader looks to tell two rows apart.
 */
function hostOf(server: CodexMcpServer): string {
  if (!server.url) return server.command ? `STDIO · ${server.command}` : 'STDIO';
  try {
    return new URL(server.url).host;
  } catch {
    return server.url;
  }
}

/**
 * `auth_status` -> the sheet's state.
 *
 * `ok` here means what it already means for Claude, whose rows are `ok` off a
 * cache file with no round trip: *no known auth problem*. It is not a claim
 * that the server answered — `mcp list` never says that, and `broken` stays the
 * word for a reachability answer nobody has asked Codex for.
 */
function stateOf(server: CodexMcpServer): { state: McpRow['state']; canDisconnect: boolean } {
  if (!server.enabled) return { state: 'unknown', canDisconnect: false };
  if (server.auth === 'not_logged_in') return { state: 'needs', canDisconnect: false };
  // The only value backed by a grant in the Keychain that `codex mcp logout`
  // can remove. A configured bearer token is the user's, not ours.
  if (server.auth === 'o_auth') return { state: 'ok', canDisconnect: true };
  if (server.auth === 'bearer_token' || server.auth === 'unsupported') {
    return { state: 'ok', canDisconnect: false };
  }
  return { state: 'unknown', canDisconnect: false };
}

function canLogin(server: CodexMcpServer): boolean {
  return (
    server.enabled && !!server.url && (server.auth === 'o_auth' || server.auth === 'not_logged_in')
  );
}

function rowOf(
  server: CodexMcpServer,
  root: string,
  project: string | undefined,
  readCwd = root || os.homedir()
): McpRow {
  const { state, canDisconnect } = stateOf(server);
  return {
    brand: 'codex',
    declarations: [
      {
        sectionRoot: root,
        ref: {
          brand: 'codex',
          name: server.name,
          key: keyOf(server, root),
          ...(server.url ? { url: server.url } : {}),
          declaration: project ? { scope: 'effective', root } : { scope: 'user' },
          readCwd
        }
      }
    ],
    canLogin: canLogin(server),
    canDisconnect,
    name: server.name,
    key: keyOf(server, project ? root : ''),
    ...(server.url ? { url: server.url } : {}),
    host: hostOf(server),
    projects: project ? [project] : [],
    entries: project ? [{ root, scope: 'project' as const }] : [],
    state,
    ...(server.disabledReason ? { note: server.disabledReason } : {})
  };
}

/**
 * Every Codex MCP server the board can see, in our own shapes.
 *
 * **Scope is derived, not read.** A row carries no origin: one run reports the
 * user's config merged with whatever the cwd's *trusted* `.codex/config.toml`
 * adds. So the home run is the user baseline, a run at each root is that root's
 * effective set. Differences retain that cwd; the native output does not prove
 * which file declared them, even when only auth or enabled facts differ. An untrusted
 * root simply contributes nothing, which needs no special case.
 *
 * A root whose run failed is left out rather than reported empty — the sheet
 * would otherwise say a repo configures nothing on the strength of a timeout.
 *
 * **One child per root, so pass repo roots and not every cwd.** Whether Codex
 * walks up from a subdirectory to find `.codex/config.toml` is unmeasured; a
 * repo root is where the file is, so it does not have to.
 */
export async function readCodexMcp(opts: {
  roots: readonly string[];
  home?: string;
  binOverride?: string;
  exec?: CodexMcpRunner;
}): Promise<McpSnapshot> {
  const exec = opts.exec ?? (await binRunner(opts.binOverride));
  if (!exec) return { rows: [], opensBoard: false };
  const home = opts.home ?? os.homedir();

  const baseline = await listAt(home, exec);
  if (!baseline) return { rows: [], opensBoard: false };
  const userByName = new Map(baseline.map((s) => [s.name, s]));

  const rows: McpRow[] = baseline.map((server) => rowOf(server, '', undefined, home));

  for (const root of [...new Set(opts.roots)]) {
    const here = await listAt(root, exec);
    if (!here) continue;
    for (const server of here) {
      // A same-name endpoint change belongs to this cwd, not the user baseline.
      const user = userByName.get(server.name);
      if (
        user &&
        user.url === server.url &&
        user.command === server.command &&
        user.enabled === server.enabled &&
        user.disabledReason === server.disabledReason &&
        user.auth === server.auth
      )
        continue;
      rows.push(rowOf(server, root, path.basename(root)));
    }
  }
  return { rows, opensBoard: rows.length > 0 };
}

/** The resolved binary as a runner, or nothing when Codex is not installed. */
async function binRunner(override?: string): Promise<CodexMcpRunner | undefined> {
  const bin = await codexBinary(override);
  if (!bin.ok) return undefined;
  return async (args, cwd) => {
    const { stdout } = await platform.executables.exec(bin.program, args, {
      cwd,
      timeout: LIST_MS,
      maxBuffer: 4 * 1024 * 1024
    });
    return stdout;
  };
}

/**
 * `codex mcp logout <name>`, at the root the cell came from.
 *
 * Nothing is returned for the reason Claude's does not: a logout that failed
 * says so by itself, because the caller re-reads and the row is still there
 * with its grant. The re-read is the report.
 */
export async function codexMcpLogout(
  target: McpActionTarget,
  opts: { binOverride?: string; exec?: CodexMcpRunner } = {}
): Promise<void> {
  const exec = opts.exec ?? (await binRunner(opts.binOverride));
  if (!exec) return;
  await checkMcpTarget(target, exec);
  try {
    await exec(['mcp', 'logout', target.name], target.readCwd);
  } catch {
    // See above.
  }
}

/**
 * `codex mcp login <name>`, as a cancellable child.
 *
 * **No pty, unlike Claude's.** Codex prints the authorization url on plain
 * stdout — measured 2026-09-04 through an ordinary pipe — so none of the
 * `script` wrapper applies and this runs anywhere, not only macOS.
 *
 * It opens the browser itself. The url is emitted anyway because the overlay
 * shows it: a browser that failed to open, or opened on the wrong profile,
 * leaves the reader with nothing else to act on.
 */
export async function prepareCodexMcpLogin(opts: {
  target: McpActionTarget;
  binOverride?: string;
}): Promise<McpLoginPrepared | { ok: false; reason: string }> {
  const bin = await codexBinary(opts.binOverride);
  if (!bin.ok) return { ok: false, reason: bin.reason };
  try {
    const exec = await binRunner(opts.binOverride);
    if (!exec) throw new Error('Codex is unavailable.');
    await checkMcpTarget(opts.target, exec);
  } catch {
    return {
      ok: false,
      reason: 'MCP declaration changed or could not be checked. Reopen MCP and try again.'
    };
  }
  return {
    start(onEvent) {
      const spawned = platform.executables.spawn(bin.program, ['mcp', 'login', opts.target.name], {
        cwd: opts.target.readCwd,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (spawned.status === 'failed') {
        onEvent({ type: 'error', message: spawned.reason });
        return { ok: false, reason: spawned.reason };
      }
      const child: ChildProcessByStdio<null, Readable, Readable> = spawned.value;

      let buf = '';
      let sentUrl: string | undefined;
      let failed = false;
      const read = (chunk: Buffer): void => {
        buf += chunk.toString('utf8');
        if (!sentUrl) {
          // `end: 'required'` so a url split across two chunks is not latched
          // half-length — the same trap `core/claude/mcp.ts` documents.
          const url = mcpAuthUrlFrom(buf);
          if (url) {
            sentUrl = url;
            onEvent({ type: 'url', url });
            onEvent({ type: 'phase', phase: 'waiting' });
          }
        }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);

      onEvent({ type: 'phase', phase: 'starting' });

      child.on('error', (error) => {
        failed = true;
        onEvent({ type: 'error', message: error.message });
      });
      child.on('close', (code) => {
        if (failed) return;
        // The stream can end carrying a url with no trailing terminator.
        if (!sentUrl) {
          const url = mcpAuthUrlFrom(buf, 'eof');
          if (url) onEvent({ type: 'url', url });
        }
        if (code === 0) {
          onEvent({ type: 'phase', phase: 'done' });
          return;
        }
        // The CLI's own last words, not a sentence of ours — it names the server
        // and why, and we have nothing to add.
        const said = buf.trim().split('\n').at(-1)?.trim();
        onEvent({ type: 'error', message: said || `codex mcp login exited ${String(code)}` });
      });

      return {
        cancel() {
          child.kill('SIGTERM');
        }
      };
    }
  };
}

async function checkMcpTarget(target: McpActionTarget, exec: CodexMcpRunner): Promise<void> {
  const rows = await listAt(target.readCwd, exec);
  const hits = rows?.filter((row) => row.name === target.name) ?? [];
  if (
    hits.length !== 1 ||
    !target.url ||
    hits[0]?.url !== target.url ||
    !hits[0]?.enabled ||
    stateOf(hits[0]).canDisconnect !== target.canDisconnect ||
    canLogin(hits[0]) !== target.canLogin
  )
    throw new Error('MCP declaration changed; reopen MCP and try again.');
}
