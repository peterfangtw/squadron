/**
 * MCP servers: which ones the repos on the board configure, which of them the
 * CLI has decided are unauthenticated, and the login that fixes one.
 *
 * Separate from `core/claude/auth.ts` on purpose. That file is one brand's account,
 * read from `claude auth status --json`. This is two JSON files on disk and a
 * login whose stdin requirement is the *opposite* of the one `startClaudeLogin`
 * is built around — see `startMcpLogin` below. The only thing they share is
 * `claudeBinary`, which is already its own module.
 *
 * Everything here was measured on 2026-08-11 against CLI 2.1.226;
 * `docs/tasks/TASK_done_mcp_auth.md` carries the readings and the runs
 * they came from.
 */

import { StringDecoder } from 'node:string_decoder';
import { claudeBinary, type BinaryFound } from '../bin';
import * as platform from '../platform';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { McpActionRef, McpActionTarget } from '../mcp_target';
import type {
  McpEntry,
  McpLoginEvent,
  McpLoginPrepared,
  McpRow,
  McpRowState,
  McpSnapshot
} from '../mcp';

export type { McpEntry, McpRow, McpRowState };

/** A health re-check is one network round trip per server; bound it. The
 *  logout below borrows it — local work, so the cap only ever catches a hang. */
const HEALTH_MS = 15_000;

/**
 * Where a declaration lives. Three, per `claude mcp add --help`; the reach of
 * each and the precedence between them are in
 * `docs/reference/cli_state/claude/mcp.md`.
 */
export type McpScope = 'local' | 'project' | 'user';

/** One server as one config file states it, under one project root. */
export type McpServer = {
  name: string;
  url: string;
  /** The project root whose block declared it. Empty for `user` scope. */
  project: string;
  /** CLI 2.1.296 on Windows matches its recorded drive spelling exactly (2026-10-31). */
  readCwd?: string;
  scope: McpScope;
};

/**
 * Servers configured by the given project roots.
 *
 * **Scoped to the roots asked for.** `~/.claude.json` accumulates a `projects`
 * entry for every directory the CLI has ever run in, most of them long dead, so
 * the whole file is never what a reader means. A root the file has not heard of
 * contributes nothing rather than throwing.
 *
 * `oauth.callbackPort` sits beside `url` on some entries and is deliberately not
 * read: the callback port is derived per server and the CLI owns both ends of
 * that loop. Nothing of ours should know a port here.
 */
export function parseMcpServers(configText: string, roots: readonly string[]): McpServer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(configText);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object') return [];
  const projects = (raw as Record<string, unknown>).projects;
  if (!projects || typeof projects !== 'object') return [];

  const out: McpServer[] = [];
  const requested = new Set(roots.map(platform.paths.key));
  const byRoot = new Map<string, { root: string; entry: unknown } | undefined>();
  for (const [root, entry] of Object.entries(projects)) {
    const key = platform.paths.key(root);
    if (requested.has(key)) byRoot.set(key, byRoot.has(key) ? undefined : { root, entry });
  }
  for (const root of roots) {
    const declaration = byRoot.get(platform.paths.key(root));
    if (!declaration) continue;
    const entry = declaration.entry;
    if (!entry || typeof entry !== 'object') continue;
    const servers = (entry as Record<string, unknown>).mcpServers;
    if (!servers || typeof servers !== 'object') continue;
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const url = (value as Record<string, unknown>).url;
      // A stdio server has no url and no OAuth flow to offer.
      if (typeof url !== 'string' || !url.trim()) continue;
      out.push({
        name,
        url: url.trim(),
        project: root,
        scope: 'local',
        ...(declaration.root !== root ? { readCwd: declaration.root } : {})
      });
    }
  }
  return out;
}

/**
 * Servers a repo declares in its own `<root>/.mcp.json` — **project** scope.
 *
 * Tracked in git, so unlike the local block this file is in every checkout of
 * the repo, worktrees included. A caller reading it per directory draws one
 * repo once per worktree; map to the repo root first.
 *
 * The shape is the local block with the `projects[<root>]` wrapper removed, so
 * the url rule below is the same one, deliberately.
 */
export function parseProjectMcpServers(text: string, root: string): McpServer[] {
  return serversIn(text, root, 'project');
}

/**
 * Servers declared machine-wide, in `~/.claude.json`'s **top-level**
 * `mcpServers` — **user** scope. Reachable from every cwd, belonging to no repo.
 *
 * Empty (`{}`) on the machine this was written against, which is exactly why it
 * is easy to forget: a reader scoping to `projects[<root>]` alone misses it and
 * nothing fails.
 */
export function parseUserMcpServers(text: string): McpServer[] {
  return serversIn(text, '', 'user');
}

/** Shared `{ mcpServers: { name: { url } } }` config block. */
function serversIn(text: string, root: string, scope: McpScope): McpServer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object') return [];
  const servers = (raw as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const out: McpServer[] = [];
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const url = (value as Record<string, unknown>).url;
    if (typeof url !== 'string' || !url.trim()) continue;
    out.push({ name, url: url.trim(), project: root, scope });
  }
  return out;
}

/**
 * Drop a `project` declaration that a `local` one shadows in the same root.
 *
 * Measured 2026-08-19: one name in both scopes at two urls — `claude mcp get`
 * answers `Scope: Local config (private to you in this project)` with the local
 * url, and `claude mcp list` prints only that one.
 *
 * **Only those two.** `user` scope carries no root, so it collides with nothing
 * here; where a user and a local server share a url they fold into one row
 * anyway, and where they do not they are two servers a reader can see.
 */
export function localOverProject(servers: readonly McpServer[]): McpServer[] {
  const shadowed = new Set<string>();
  for (const server of servers) {
    if (server.scope === 'local') shadowed.add(server.project + '\0' + server.name);
  }
  return servers.filter((s) => s.scope !== 'project' || !shadowed.has(s.project + '\0' + s.name));
}

/**
 * What `claude mcp list` says about one server, which is more than the
 * needs-auth cache can say.
 *
 * `pending` is a `.mcp.json` server nobody has approved: it does not load into a
 * session, and `claude mcp login` refuses it outright. Neither of the sheet's
 * two verbs applies to one.
 */
export type McpHealthState = 'ok' | 'broken' | 'pending' | 'needs';

export type McpHealth = {
  state: McpHealthState;
  url: string;
  note?: string;
  /**
   * The transport in parentheses — `HTTP`, `SSE`. **Absent is the signal**: a
   * line printing none is the claude.ai connector, which is the one thing in
   * this list that no config file on the machine declares. Measured 2026-08-19,
   * CLI 2.1.226; recorded in `docs/reference/cli_state/claude/mcp.md`.
   */
  transport?: string;
};

/**
 * Read `claude mcp list`'s verdicts. Keyed `<root>|<name>`.
 *
 * **By root and name, not by url.** Two entries genuinely share a url on a real
 * machine — the claude.ai connector and a repo's own `slack` are both
 * `https://mcp.slack.com/mcp` — so a url-keyed map keeps one of them.
 *
 * Format, measured 2026-08-19 against CLI 2.1.226
 * (`docs/reference/cli_state/claude/mcp.md`):
 *
 * ```
 * claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected
 * sentry: https://mcp.sentry.dev/sse (SSE) - ✘ Failed to connect — …
 * probe-linear: https://mcp.linear.app/mcp (HTTP) - ⏸ Pending approval (run `claude` to approve)
 * ```
 *
 * **Four markers.** `!` is the oldest of them, recorded 2026-08-10 in
 * `TASK_done_mcp_auth.md` on a line whose name is padded to align with its
 * neighbours — `slack:  https://…`, two spaces. Both cost that line entirely
 * under a three-marker single-space reader, and it is the worst one to lose: an
 * unauthenticated server whose cache key is missing then paints Connected,
 * which is the exact lie this function exists to end.
 * Windows CLI 2.1.296 (2026-10-31) prints √ and × for Connected and Failed.
 *
 * A name may contain spaces, the transport may be absent (the claude.ai
 * connector prints none) and its label is not always one uppercase word, so a
 * line is anchored on its ` - <marker>` suffix rather than on anything before.
 */
export function parseMcpHealth(stdout: string, root: string): Map<string, McpHealth> {
  const out = new Map<string, McpHealth>();
  const MARK: Record<string, McpHealthState> = {
    '✔': 'ok',
    '√': 'ok',
    '✘': 'broken',
    '×': 'broken',
    '⏸': 'pending',
    '!': 'needs'
  };
  for (const raw of strip(stdout).split('\n')) {
    const line = raw.trim();
    // The `[Conflicting scopes]` block follows the list and its lines carry
    // `: https://` too, so it would otherwise parse as servers. Ended on its own
    // bracket rather than on the blank line before it — a blank line between two
    // entries would silently drop everything after the first.
    if (line.startsWith('[')) break;
    const at = line.match(/^(.+?):\s+(\S+?)(?:\s+\(([^)]+)\))?\s+-\s+([✔√✘×⏸!])\s*(.*)$/u);
    const state = at?.[4] ? MARK[at[4]] : undefined;
    if (!at || !state) continue;
    // U+FE0F rides some of these glyphs and survives a trim.
    const note = (at[5] ?? '').replace(/^️/, '').trim();
    out.set(healthKey(root, at[1] ?? ''), {
      state,
      url: at[2] ?? '',
      ...(note && state !== 'ok' ? { note } : {}),
      ...(at[3] ? { transport: at[3] } : {})
    });
  }
  return out;
}

/**
 * How a health reading is filed. NUL rather than `|`, which is legal in both a
 * POSIX path and a server name and so cannot separate the two unambiguously.
 */
export const healthKey = (root: string, name: string): string => root + '\0' + name;

/**
 * The server names the CLI currently believes are unauthenticated, out of
 * `~/.claude/mcp-needs-auth-cache.json` — `{"linear":{"timestamp":…},…}`.
 *
 * Read rather than `claude mcp list`, which is authoritative and spends a
 * network round trip per server on a surface that repaints on a 30s tick.
 */
export function parseNeedsAuth(cacheText: string): Set<string> {
  const names = new Set<string>();
  let raw: unknown;
  try {
    raw = JSON.parse(cacheText);
  } catch {
    return names;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return names;
  for (const name of Object.keys(raw)) names.add(name);
  return names;
}

/**
 * Servers plus cache -> the rows the popover draws.
 *
 * The keychain keys a token `mcpOAuth/<name>|<hash of url>`. Retain native
 * aliases separately; the same name/url can share a row across repo roots.
 * User declarations stay separate from repo declarations.
 *
 * **The cache is intersected, never trusted alone.** `claude mcp remove` leaves
 * its key behind — measured — so a list drawn off the cache shows servers that
 * no longer exist, each asking to be authorised.
 */
export function mcpRows(
  servers: readonly McpServer[],
  needsAuth: ReadonlySet<string>,
  canLogin: boolean = platform.consoleLogin.support.supported
): McpRow[] {
  const byIdentity = new Map<string, McpRow>();
  for (const server of servers) {
    const identity =
      (server.scope === 'user' ? 'user' : 'repo') + '\0' + server.name + '\0' + server.url;
    const seen = byIdentity.get(identity);
    const ref: McpActionRef = {
      brand: 'claude',
      name: server.name,
      key: server.url,
      url: server.url,
      declaration:
        server.scope === 'user'
          ? { scope: 'user' }
          : { scope: server.scope, root: server.readCwd ?? server.project },
      readCwd: server.readCwd ?? (server.project || os.homedir())
    };
    const declaration = { sectionRoot: server.project, ref };
    const project = basename(server.project);
    // A user server has no root, so it contributes a cell and no repo.
    const entry = server.project ? [{ root: server.project, scope: server.scope }] : [];
    if (seen) {
      if (!seen.projects.includes(project)) seen.projects.push(project);
      // Not deduped by root the way `projects` is by basename: one root can
      // reach a url under two scopes, and which scopes is the thing to show.
      seen.entries.push(...entry);
      seen.declarations?.push(declaration);
      continue;
    }
    byIdentity.set(identity, {
      declarations: [declaration],
      brand: 'claude',
      canLogin,
      // Disconnect on `needs` would replace Authorise and block login.
      // `withHealth` sets it for authorised, unreachable (`broken`) rows.
      canDisconnect: !needsAuth.has(server.name),
      name: server.name,
      key: server.url,
      url: server.url,
      host: hostOf(server.url),
      projects: server.project ? [project] : [],
      entries: entry,
      state: needsAuth.has(server.name) ? 'needs' : 'ok'
    });
  }
  return [...byIdentity.values()];
}

/**
 * Claude's finished rows: config rows reconciled with the cache and with what
 * `claude mcp list` last said, then the account's connectors behind them.
 *
 * The shared fold groups these and interprets none of it. `servers` retain
 * original read roots until health has been applied; the cache text
 * is `undefined` when the file is missing, which reads as an empty cache.
 */
export function claudeMcpRows(opts: {
  servers: readonly McpServer[];
  needsAuthCache?: string;
  health?: Map<string, McpHealth>;
  canLogin?: boolean;
}): McpRow[] {
  const canLogin = opts.canLogin ?? platform.consoleLogin.support.supported;
  const rows = withHealth(
    mcpRows(opts.servers, parseNeedsAuth(opts.needsAuthCache ?? '{}'), canLogin),
    opts.health
  );
  return [...rows, ...accountServers(rows, opts.health, canLogin)];
}

export function claudeMcpSnapshot(opts: {
  roots: readonly string[];
  config?: string;
  projectByRoot: Readonly<Record<string, string | undefined>>;
  needsAuthCache?: string;
  health?: Map<string, McpHealth>;
  canLogin?: boolean;
}): McpSnapshot {
  const roots = [...new Set(opts.roots)];
  const servers = localOverProject([
    ...(opts.config ? parseMcpServers(opts.config, roots) : []),
    ...roots.flatMap((root) => {
      const text = opts.projectByRoot[root];
      return text ? parseProjectMcpServers(text, root) : [];
    }),
    ...(opts.config ? parseUserMcpServers(opts.config) : [])
  ]);
  return {
    opensBoard:
      opts.config !== undefined || roots.some((root) => opts.projectByRoot[root] !== undefined),
    rows: claudeMcpRows({ ...opts, servers })
  };
}

export async function readClaudeMcp(opts: {
  roots: readonly string[];
  health?: Map<string, McpHealth>;
}): Promise<McpSnapshot> {
  const paths = await import('../paths');
  const roots = [...new Set(opts.roots)];
  // Every cwd, including worktrees: declaration identity precedes repo grouping.
  const [config, needsAuthCache, projects] = await Promise.all([
    fs.readFile(paths.CLAUDE_CONFIG_FILE, 'utf8').catch(() => undefined),
    fs.readFile(paths.MCP_NEEDS_AUTH_FILE, 'utf8').catch(() => undefined),
    Promise.all(
      roots.map(
        async (root) =>
          [
            root,
            await fs.readFile(path.join(root, '.mcp.json'), 'utf8').catch(() => undefined)
          ] as const
      )
    )
  ]);
  return claudeMcpSnapshot({
    ...opts,
    config,
    needsAuthCache,
    projectByRoot: Object.fromEntries(projects)
  });
}

/**
 * Overlay what `claude mcp list` said on rows the config reads built.
 *
 * **A row with no answer is left exactly as it was.** The health map is absent
 * until someone opens the sheet, and a root that timed out contributes nothing —
 * neither case is evidence that a server is broken, and painting one as broken
 * on no evidence is the failure this whole step exists to end.
 *
 * A row can be reached from several roots and one of them may have timed out, so
 * the first root with an answer wins — and **the row records which root that
 * was**. A `pending` note says to run `claude` in a directory, and naming a
 * different one than the reading came from sends the reader to the wrong repo.
 *
 * A user row can use a root's reading only when its endpoint matches.
 * A same-named project declaration can shadow it at that root.
 */
function withHealth(rows: McpRow[], health: Map<string, McpHealth> | undefined): McpRow[] {
  if (!health?.size) return rows;
  return rows.map((row) => {
    const roots = row.entries.length
      ? row.entries.map((e) => e.root)
      : [
          ...new Set([
            ...(row.declarations ?? [])
              .filter((declaration) => declaration.ref.declaration.scope === 'user')
              .map((declaration) => declaration.ref.readCwd),
            ...anyRootIn(health)
          ])
        ];
    for (const entryRoot of roots) {
      const root =
        row.declarations?.find((declaration) => declaration.sectionRoot === entryRoot)?.ref
          .readCwd ?? entryRoot;
      const said = health.get(healthKey(root, row.name));
      if (!said || said.url !== row.url) continue;
      if (
        !row.entries.length &&
        rows.some(
          (other) =>
            other.name === row.name &&
            other.entries.length > 0 &&
            (other.entries.some((entry) => entry.root === root) ||
              other.declarations?.some((declaration) => declaration.ref.readCwd === root))
        )
      )
        continue;
      // `needs` is the cache's own reading and outranks a bare `ok` here: the
      // list reports a server it can reach as connected whether or not this
      // machine holds a token for it.
      if (said.state === 'ok' && row.state === 'needs') return row;
      return {
        ...row,
        state: said.state,
        // Restamped, because this is where a row becomes `broken` or `pending`
        // — and the answer differs for the two. `broken` is authorised and
        // unreachable, so Disconnect is the only verb that applies; `pending`
        // is a server nobody has approved and takes neither.
        canDisconnect: said.state === 'ok' || said.state === 'broken',
        answeredBy: root,
        ...(said.note ? { note: said.note } : {})
      };
    }
    return row;
  });
}

const anyRootIn = (health: Map<string, McpHealth>): string[] => [
  ...new Set([...health.keys()].map((k) => k.slice(0, k.indexOf('\0'))))
];

/**
 * The servers `claude mcp list` reports that no config file we read declares.
 *
 * The claude.ai connector is the whole of this set today: it arrives with the
 * signed-in account, appears from every cwd, and is in nothing on disk — so
 * without this the trailing section is empty on a machine that plainly has a
 * machine-wide server. It carries neither verb: there is no entry to remove.
 *
 * **Only names no row has at all**, since a repo's own server is already a row
 * and its health has been overlaid onto it by `withHealth`.
 *
 * **And only lines that printed no transport, at an http url.** A name we do
 * not know that *does* print one is a server some config declares and this read
 * did not reach — a root that was not passed, a file that would not parse — and
 * calling that the account's would be a guess wearing a label. The url test is
 * the second half of the same care: a **stdio** server is declared in a config
 * we did read and dropped on purpose (`serversIn` keeps url-bearing entries
 * only), so its name is in no row either, and what stands where the url goes is
 * a command path. Whether the CLI prints a transport for one is unmeasured, so
 * this does not depend on it. Both cases stay undrawn, exactly as before.
 */
function accountServers(
  rows: readonly McpRow[],
  health: Map<string, McpHealth> | undefined,
  canLogin: boolean
): McpRow[] {
  if (!health?.size) return [];
  const known = new Set(rows.map((row) => row.name));
  const out = new Map<string, McpRow>();
  for (const [key, said] of health) {
    const name = key.slice(key.indexOf('\0') + 1);
    if (said.transport || !said.url.startsWith('http')) continue;
    if (known.has(name) || out.has(name)) continue;
    out.set(name, {
      brand: 'claude',
      canLogin,
      // See `McpRow.fromAccount`: the verb reads this flag, the paint reads `fromAccount`.
      canDisconnect: false,
      name,
      key: said.url,
      url: said.url,
      host: hostOf(said.url),
      projects: [],
      entries: [],
      state: said.state,
      fromAccount: true,
      ...(said.note ? { note: said.note } : {})
    });
  }
  return [...out.values()];
}

function basename(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// The sheet fold, and the login vocabulary every brand emits, is `core/mcp.ts`.

// --- the login child ---------------------------------------------------------

/**
 * Ask the CLI to re-check its servers, for the side effect on the cache file.
 *
 * **Because whether a completed login prunes its own key is not something we
 * have measured.** `claude mcp remove` demonstrably does not
 * (`docs/reference/cli_state/claude/mcp.md`), and assuming login does would
 * leave a just-authorised server reading *Needs auth* until something else
 * happened to rewrite the file. `claude mcp list` is the authoritative check and
 * rewrites the cache as it goes, so running it once settles the question without
 * anyone having to answer it.
 *
 * This is the one place that shells out for MCP state, and it is a rare event —
 * one completed login, not the 30s tick the "read the files" decision was about.
 * Output is discarded: the answer is read back off disk like everything else.
 */
export async function recheckMcpHealth(
  cwd: string,
  binOverride?: string
): Promise<Map<string, McpHealth>> {
  const bin = await claudeBinary(binOverride);
  if (!bin.ok) return new Map();
  try {
    const { stdout } = await platform.executables.exec(bin.program, ['mcp', 'list'], {
      cwd,
      timeout: HEALTH_MS,
      maxBuffer: 256 * 1024
    });
    return parseMcpHealth(stdout, cwd);
  } catch (err) {
    // **Exit is non-zero on some runs that answered fine**, so the output is
    // read either way rather than thrown away with the error: two unreachable
    // servers exited 0 when measured, and the code is not a contract we have.
    // A timeout leaves the previous reading, which is what an empty map means.
    const stdout = (err as { stdout?: string })?.stdout;
    return typeof stdout === 'string' ? parseMcpHealth(stdout, cwd) : new Map();
  }
}

/**
 * Clear the machine's stored credentials for one server.
 *
 * **The opposite of `startMcpLogin` in the one way that matters: no pty.**
 * Measured 2026-08-11 with stdin `< /dev/null` — the condition the login is
 * defeated by — and it answers, naming the project's servers when the name is
 * unknown. So it is an ordinary child, the shape `core/claude/auth.ts`'s
 * `claudeAuthLogout` already has, and none of the `script` wrapper applies.
 *
 * `cwd` for the same reason the login takes one: `mcpServers` is project-scoped
 * and from elsewhere the server does not exist.
 *
 * Nothing is returned, because nothing would be shown. A logout that failed
 * says so by itself — the caller re-reads the two files, and the row it draws is
 * still Connected. Same argument as the account sign-out's.
 */
export async function mcpLogout(target: McpActionTarget, binOverride?: string): Promise<void> {
  const bin = await claudeBinary(binOverride);
  if (!bin.ok) return;
  await checkMcpTarget(target, bin);
  try {
    await platform.executables.exec(bin.program, ['mcp', 'logout', target.name], {
      cwd: target.readCwd,
      timeout: HEALTH_MS,
      maxBuffer: 64 * 1024
    });
  } catch {
    // See above: the re-read is the report.
  }
}

/**
 * Terminal escapes out, text in.
 *
 * Shared by both readers of the buffer rather than living inside the url match:
 * the failure line goes verbatim into a note and onto the popover, so a CLI that
 * colours it under a pty would put `\x1b[31m` fragments in front of the reader.
 * Whether it does is not measured — the captured refusal came from the *piped*
 * run, which has no tty and so no colour by construction, and cannot answer it.
 * This file has already established that the CLI decorates under a pty, so the
 * cheap close is to strip both the same way.
 */
function strip(text: string): string {
  // Control characters are the point: this reads a terminal's own output, and
  // ESC and BEL are the only things marking where an escape starts and ends.
  /* eslint-disable no-control-regex */
  return (
    text
      // OSC-8 hyperlink: ESC ] 8 ;; <target> BEL. Dropping the target and
      // keeping the visible label is deliberate — they are the same url, and
      // the label is the one not wrapped in escapes.
      .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  );
  /* eslint-enable no-control-regex */
}

/**
 * Pull the authorize URL out of login output.
 *
 * **Not `loginUrlFrom` from `core/claude/auth.ts`**, which was measured against this
 * exact output and matches neither of its branches: under a pty the CLI wraps
 * the link in an OSC-8 hyperlink, so the labelled branch cannot cross the escape
 * from `authorize:` to `https`, and the fallback requires `/oauth/authorize`
 * while Notion's endpoint is plain `/authorize`.
 *
 * The marker that does work is `code_challenge=`. It is part of OAuth 2.1 +
 * PKCE rather than any one server's spelling, which is the seam this belongs on:
 * every server publishing `.well-known/oauth-protected-resource` sends it.
 *
 * **A terminated url only, and that is the whole of why `end` exists.** This is
 * fed a growing buffer, so a chunk boundary can land inside the url. The OSC-8
 * strip needs its BEL to fire, so a half-arrived escape leaves a raw url
 * *prefix* sitting in the text — and a prefix matches `code_challenge=` just as
 * well as the real thing. The caller latches what it gets, so the reader would
 * be handed a truncated authorize url that fails at the server and is never
 * re-checked. Requiring whitespace or a quote after it means a partial simply
 * does not match, and the next chunk brings the terminator. `script` emits
 * CRLF, so the terminator is always there in the end; `finalise` covers the
 * stream that ends without one.
 */
export function mcpAuthUrlFrom(
  text: string,
  end: 'required' | 'eof' = 'required'
): string | undefined {
  const clean = strip(text);
  const pattern =
    end === 'required'
      ? /https?:\/\/[^\s'"<>]*code_challenge=[^\s'"<>]*(?=[\s'"<>])/
      : /https?:\/\/[^\s'"<>]*code_challenge=[^\s'"<>]*/;
  return clean.match(pattern)?.[0];
}

/**
 * Exported so chunk sequences can be tested for repeated phases and partial urls.
 * `finalise` accepts a final url without the terminator required during reads.
 */
export function mcpLoginReader(onEvent: (event: McpLoginEvent) => void): {
  read(chunk: Buffer | string, stream?: 'stdout' | 'stderr'): void;
  finalise(): void;
  failed(): boolean;
  lastLine(): string | undefined;
} {
  let buf = '';
  let urlSent: string | undefined;
  let waitingSent = false;
  let failed = false;
  let bytes = 0;
  let diagnostic: string | undefined;
  const buffers = { stdout: '', stderr: '' };
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };

  const limit = (): void => {
    if (failed) return;
    failed = true;
    const message = 'Authorisation output exceeded its limit.';
    onEvent({ type: 'error', message });
    onEvent({ type: 'phase', phase: 'error', message });
  };

  const emitUrl = (url: string): void => {
    if (urlSent || failed) return;
    if (Buffer.byteLength(url, 'utf8') > 16384) {
      limit();
      return;
    }
    urlSent = url;
    onEvent({ type: 'url', url });
    onEvent({ type: 'phase', phase: 'browser' });
  };

  const scan = (end: 'required' | 'eof'): void => {
    if (!urlSent) {
      const url = mcpAuthUrlFrom(buf, end);
      if (url) emitUrl(url);
    }
    // Latched, like the url: the whole buffer is re-read on every chunk and the
    // CLI keeps writing after this line, so an unlatched test re-fired the
    // phase — and every one of those is a panel repaint. Measured 2026-08-11.
    if (urlSent && !waitingSent && !failed && /Waiting for authorization/i.test(buf)) {
      waitingSent = true;
      onEvent({ type: 'phase', phase: 'waiting' });
    }
    if (!failed) {
      const reason = loginFailure(buf, end);
      if (reason) {
        failed = true;
        onEvent({ type: 'error', message: reason });
        onEvent({ type: 'phase', phase: 'error', message: reason });
      }
    }
  };

  // `chunk.toString('utf8')` per chunk splits multi-byte characters: the CLI
  // writes `…` and `—`, and a boundary inside one yields U+FFFD in the buffer
  // and so in a note. The decoder holds the partial bytes until they complete.
  return {
    read(chunk, stream = 'stdout') {
      if (failed) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1048576) {
        limit();
        return;
      }
      const text = typeof chunk === 'string' ? chunk : decoders[stream].write(chunk);
      buf = buffers[stream];
      for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        if (Buffer.byteLength(buf) + Buffer.byteLength(part) > 65536) {
          limit();
          return;
        }
        const partialUrl = mcpAuthUrlFrom(buf + part, 'eof');
        if (partialUrl && Buffer.byteLength(partialUrl) > 16384) {
          limit();
          return;
        }
        buf += part;
        scan('required');
        if (part.endsWith('\n')) {
          const line = strip(buf).trim();
          if (line) diagnostic = line;
          buf = '';
        }
      }
      buffers[stream] = buf;
    },
    finalise() {
      if (failed) return;
      for (const stream of ['stdout', 'stderr'] as const) {
        buf = buffers[stream] + decoders[stream].end();
        scan('eof');
        if (strip(buf).trim()) diagnostic = strip(buf).trim();
      }
    },
    failed() {
      return failed;
    },
    /**
     * The CLI's last line when the flow never started.
     *
     * A cwd that does not configure the server exits 1 before a url, and that
     * line is the only thing it said (2026-09-22, `No MCP server named`).
     * Once a url has been emitted, `loginFailure` owns the sentence — a later
     * line is not a reason to put on the cell.
     */
    lastLine(): string | undefined {
      if (urlSent) return undefined;
      return (diagnostic ?? strip(buf))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1);
    }
  };
}

/**
 * The CLI's own words when it gives up, worth passing through verbatim.
 *
 * **`end` for the url's reason, not a different one.** `[^\n]*` matches to the
 * end of a buffer whose newline has not arrived yet, and `failed` latches what
 * it gets — so a chunk boundary mid-sentence shipped the reader a fragment,
 * losing the half that says what to do about it ("Re-run in an interactive
 * terminal…"). Requiring the newline means a partial waits for the next chunk;
 * `finalise` relaxes it once the stream is over, so a last line with no newline
 * is still caught and still suppresses the generic message.
 */
function loginFailure(text: string, end: 'required' | 'eof'): string | undefined {
  const pattern =
    end === 'required'
      ? /Couldn't complete authentication[^\n]*(?=\n)/
      : /Couldn't complete authentication[^\n]*/;
  return strip(text).match(pattern)?.[0]?.trim();
}

/**
 * Start `claude mcp login <name> --no-browser` for one server.
 *
 * `cwd` must be a directory that configures the server. A project-scoped name
 * is invisible elsewhere — the CLI exits 1 before a url with `No MCP server
 * named`. User scope is the exception and answers from `/tmp` (2026-09-22,
 * CLI 2.1.258), so the home directory does too.
 */
export async function prepareMcpLogin(opts: {
  target: McpActionTarget;
  binOverride?: string;
}): Promise<McpLoginPrepared | { ok: false; reason: string }> {
  if (!platform.consoleLogin.support.supported) {
    return {
      ok: false,
      reason: 'Console login is unavailable here. Run the login command in a terminal instead.'
    };
  }
  const bin = await claudeBinary(opts.binOverride);
  if (!bin.ok) return { ok: false, reason: bin.reason };

  try {
    await checkMcpTarget(opts.target, bin, { timeout: 5000 });
  } catch {
    return {
      ok: false,
      reason: 'MCP declaration changed or could not be checked. Reopen MCP and try again.'
    };
  }
  return {
    start(onEvent) {
      onEvent({ type: 'phase', phase: 'starting' });

      const spawned = platform.consoleLogin.run(
        bin.program,
        ['mcp', 'login', opts.target.name, '--no-browser'],
        {
          cwd: opts.target.readCwd,
          beforeLaunch: (signal) => checkMcpTarget(opts.target, bin, { signal, timeout: 5000 })
        }
      );
      if (!spawned.supported || spawned.status === 'failed') {
        onEvent({ type: 'error', message: spawned.reason });
        return { ok: false, reason: spawned.reason };
      }
      const child = spawned.value;

      let urlSeen = false;
      let settled = false,
        urlExpired = false;
      let urlMonotonicExpiry = Infinity,
        urlUtcExpiry = Infinity;
      let urlDeadline: ReturnType<typeof setTimeout> | undefined;
      const expireUrl = (): void => {
        if (urlSeen || urlExpired || settled) return;
        urlExpired = true;
        settled = true;
        clearTimeout(urlDeadline);
        child.cancel();
        onEvent({
          type: 'phase',
          phase: 'error',
          message: 'Authorisation URL did not arrive in time.'
        });
      };
      const ready = (): void => {
        if (urlDeadline || urlSeen || settled || urlExpired) return;
        urlMonotonicExpiry = performance.now() + 30000;
        urlUtcExpiry = Date.now() + 30000;
        urlDeadline = setTimeout(expireUrl, 30000);
      };
      child.on('ready', ready);
      if (child.ready) ready();
      const reader = mcpLoginReader((event) => {
        if (urlExpired) return;
        if (
          event.type === 'url' &&
          (performance.now() >= urlMonotonicExpiry || Date.now() >= urlUtcExpiry)
        ) {
          expireUrl();
          return;
        }
        if (event.type === 'error') clearTimeout(urlDeadline);
        if (event.type === 'url') {
          urlSeen = true;
          clearTimeout(urlDeadline);
        }
        onEvent(event);
      });

      child.stdout.on('data', (chunk: Buffer) => {
        reader.read(chunk, 'stdout');
        if (reader.failed()) child.cancel();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        reader.read(chunk, 'stderr');
        if (reader.failed()) child.cancel();
      });
      child.on('error', (err) => {
        clearTimeout(urlDeadline);
        settled = true;
        onEvent({ type: 'phase', phase: 'error', message: err.message });
      });
      child.on('close', (completion) => {
        clearTimeout(urlDeadline);
        if (completion.kind === 'exited') reader.finalise();
        if (settled || reader.failed()) return;
        if (completion.kind === 'exited' && completion.code === 0)
          onEvent({ type: 'phase', phase: 'done' });
        else if (completion.kind !== 'cancelled') {
          // The last non-empty line when no url was printed. Measured for
          // `No MCP server named`; a later hint line would win, the same risk
          // Codex's arm already takes. `loginFailure` already took the stdin wall.
          onEvent({
            type: 'phase',
            phase: 'error',
            message:
              completion.kind === 'failed'
                ? completion.reason
                : (reader.lastLine() ?? 'Authorisation did not finish.')
          });
        }
      });

      return {
        cancel() {
          settled = true;
          clearTimeout(urlDeadline);
          child.cancel();
        }
      };
    }
  };
}

/** `get` reports the effective declaration at this cwd, including user shadowing. */
async function checkMcpTarget(
  target: McpActionTarget,
  bin: BinaryFound,
  options: { signal?: AbortSignal; timeout?: number } = {}
): Promise<void> {
  const { stdout } = await platform.executables.exec(bin.program, ['mcp', 'get', target.name], {
    cwd: target.readCwd,
    timeout: options.timeout ?? HEALTH_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    maxBuffer: 64 * 1024
  });
  const urls = [...stdout.matchAll(/^\s*URL:\s*(\S+)\s*$/gm)];
  const scopes = [...stdout.matchAll(/^\s*Scope:\s*(User|Local|Project)\b/gm)];
  if (
    urls.length !== 1 ||
    scopes.length !== 1 ||
    !target.url ||
    urls[0]?.[1] !== target.url ||
    scopes[0]?.[1]?.toLowerCase() !== target.declaration.scope
  )
    throw new Error('MCP declaration changed; reopen MCP and try again.');
}
