/**
 * Fold MCP disk rows into one sheet view, cut into sections.
 *
 * Brand spelling stays at each CLI's seam. This file joins by url and writes
 * the panel's own shapes — a url only one brand lists is one cell, not a ghost
 * of the other.
 *
 * **The join is within a section, never across two.** A section is a repo, and
 * a repo's `linear` and a *user*-scope Grok `linear` are two declarations that
 * happen to share a url — merging them put a machine-wide cell on a repo's row
 * and made a Disconnect there look like it reached only that repo. Decided with
 * the user 2026-08-19, along with the price: the two brand logins for one url
 * stop sitting side by side unless both live on the same page. A project
 * `.grok/config.toml` *is* that repo's, so it joins Claude on the repo page
 * (observed 2026-08-20, CLI 1.0.5).
 */

import { brandName } from './accounts';
import { isBrand } from './brands';
import type { BrandId } from './model';
import { sameMcpRef, type McpActionRef, type McpActionTarget } from './mcp_target';
export type McpRowState = 'ok' | 'needs' | 'broken' | 'pending' | 'unknown';

/** One root reaching a url, and how it declares it. */
export type McpEntry = { root: string; scope: 'local' | 'project' | 'user' };

/** The seam decides `brand` and `canLogin`. The fold carries those answers. */
export type McpRow = {
  brand: BrandId;
  /** Whether this host can run that brand's MCP login. */
  canLogin: boolean;
  /**
   * Whether this row's credential is ours to remove — decided at the seam that
   * read it, never re-derived from `state`. A Codex server authenticated from a
   * configured bearer token is connected and owns nothing we could take.
   */
  canDisconnect: boolean;
  name: string;
  /** Original declarations, retained before presentation remaps their roots. */
  declarations?: { sectionRoot: string; ref: McpActionRef }[];
  /**
   * What joins this row to another brand's, and what survives a repaint.
   *
   * An HTTP row's key is its url, so two brands listing one url land on one
   * row. A transport with no url keys on brand, scope, root and name instead —
   * it joins with nothing, which is correct: nobody else is talking to that
   * process.
   */
  key: string;
  /** Absent for a transport that has none, which is every STDIO server. */
  url?: string;
  /** Host alone — a full MCP url is too long for a 316px popover. */
  host: string;
  /** Basenames of the project roots configuring this url, first seen first. */
  projects: string[];
  /** Full roots for grouping: two repos can share the basename used in `projects`. */
  entries: McpEntry[];
  state: McpRowState;
  /**
   * Why, when the state alone does not say — the CLI's own sentence for a
   * `broken` or `pending` row. Nothing composes this; it is quoted.
   */
  note?: string;
  /**
   * Which root's `claude mcp list` produced `state` and `note`, when one did.
   *
   * Not always `entries[0]`: a row is reachable from several roots and the first
   * of them may have timed out. A `pending` note names a directory to run
   * `claude` in, so the cell has to carry the root that sentence is about.
   */
  answeredBy?: string;
  /**
   * Declared by the signed-in claude.ai account rather than by any config file
   * — the connector, which `claude mcp list` reports from every cwd and which
   * appears in nothing on disk that we read.
   *
   * **Neither verb applies to one.** There is no entry to remove and no login
   * to start; it arrives with the account and leaves with it.
   */
  fromAccount?: boolean;
};

export type McpLoginPhase = 'starting' | 'browser' | 'waiting' | 'done' | 'error';

export type McpLoginEvent =
  | { type: 'phase'; phase: McpLoginPhase; message?: string }
  | { type: 'url'; url: string }
  | { type: 'error'; message: string };

export type McpLoginSession = { cancel(): void };

export type McpLoginPrepared = {
  start(onEvent: (event: McpLoginEvent) => void): McpLoginSession | { ok: false; reason: string };
};

export type McpLoginLive = {
  target: McpActionTarget;
  phase: McpLoginPhase;
  /** A `done` record carries none: no state draws a note beside Connected. */
  note?: string;
  url?: string;
};

/** The host resolves repo labels and paths. Unlisted roots still get their own section. */
export type McpRepo = {
  root: string;
  label: string;
  /** The line under an open head. Shortened host-side. */
  path?: string;
};

/**
 * The board, as the MCP read needs it: where to look, and which repo each of
 * those places belongs to.
 *
 * **`roots` and `repos` are different lists on purpose.** `roots` is every
 * directory a config could be keyed by — session cwds, worktrees, this
 * window's folder — and `repos` is the sections, which is one per checkout.
 * Deriving either from the other needs git, and the poll has already asked.
 */
export type McpBoard = {
  roots: readonly string[];
  repos: readonly McpRepo[];
  repoOf: Readonly<Record<string, string>>;
  ownRoot?: string;
};

/** Native producers retain original provenance and resolve capability policy. */
export type McpSnapshot = {
  rows: readonly McpRow[];
  /**
   * Opens the board-read gate, not a verdict that every declaration was read.
   * Readable config text opens it, including when that text is empty or
   * malformed. A missing read does not. Rows are independent: combine every
   * snapshot, then gate once on this flag.
   */
  opensBoard: boolean;
};

const NO_REPO = 'Not from a repo';

const NO_REPO_PATH = 'every cwd';

/** CLI command spellings belong here, per `mcpHint`. */
const EMPTY_LINE =
  'No MCP server configured. claude mcp add from this repo, grok mcp add --scope project, codex mcp add, or commit one to its .mcp.json.';

function paintOf(brand: BrandId): { label: string; mark: string } {
  return { label: brandName(brand), mark: brand };
}

function cellOf(
  row: McpRow,
  extra?: {
    state?: McpBrandCell['state'];
    note?: string;
    url?: string;
    root?: string;
    supported?: boolean;
    canDisconnect?: boolean;
  }
): McpBrandCell {
  const paint = paintOf(row.brand);
  const root = extra?.root ?? row.answeredBy;
  const note = extra?.note ?? row.note;
  const candidates = row.declarations?.filter((d) => d.sectionRoot === (extra?.root ?? ''));
  const target = candidates?.length === 1 ? candidates[0]?.ref : undefined;
  return {
    ...(target ? { target } : {}),
    brand: row.brand,
    name: target?.name ?? row.name,
    label: paint.label,
    mark: paint.mark,
    state: extra?.state ?? row.state,
    supported: (extra?.supported ?? row.canLogin) && (!row.declarations || !!target),
    canDisconnect: (extra?.canDisconnect ?? row.canDisconnect) && (!row.declarations || !!target),
    ...(note ? { note } : {}),
    ...(extra?.url ? { url: extra.url } : {}),
    ...(root ? { root } : {}),
    ...(row.fromAccount ? { fromAccount: true } : {})
  };
}

/** Compute the hint after synthesis, or it claims no servers above a busy login row. */
export function foldMcpView(opts: {
  rows: readonly McpRow[];
  live?: McpLoginLive;
  repos?: readonly McpRepo[];
  ownRoot?: string;
}): McpView {
  const groups = groupMcpByRepo(opts);
  const servers = groups.flatMap((group) => group.servers);

  // A synthesised login belongs to no section. Group first so its Cancel remains visible.
  if (opts.live) {
    const before = servers.length;
    overlayLive(servers, opts.live);
    const made = servers.slice(before);
    if (made.length) trailing(groups).servers.push(...made);
  }

  const summary = summaryOf(servers);
  return {
    groups,
    hint: mcpHint(servers),
    ...(summary ? { summary, summaryWants: summaryWants(servers) } : {})
  };
}

function groupMcpByRepo(opts: {
  rows: readonly McpRow[];
  repos?: readonly McpRepo[];
  ownRoot?: string;
}): McpGroupView[] {
  const known = new Map<string, McpRepo>();
  for (const repo of opts.repos ?? []) known.set(repo.root, repo);
  // Without its own section marked `here`, this window opens the sheet with everything shut.
  if (opts.ownRoot && ![...known.keys()].some((root) => sameRoot(root, opts.ownRoot ?? ''))) {
    known.set(opts.ownRoot, { root: opts.ownRoot, label: leaf(opts.ownRoot) });
  }
  // Omitting a declaring root would lose its server.
  for (const row of opts.rows) {
    for (const entry of row.entries) {
      if (!known.has(entry.root))
        known.set(entry.root, { root: entry.root, label: leaf(entry.root) });
    }
  }

  const pages = new Map<string, McpServerView[]>();
  for (const root of known.keys()) pages.set(root, []);

  const machine = new Map<string, McpServerView>();
  /** A user server and account connector can share a url. Replacing either loses its login cell. */
  const onto = (row: McpRow, cell: McpBrandCell): void => {
    const aliasKey = JSON.stringify([row.key, row.brand, row.name]);
    const seen = machine.get(row.key);
    if (!cell.fromAccount && seen?.brands.some((c) => c.brand === cell.brand && !c.fromAccount)) {
      machine.set(aliasKey, {
        name: row.name,
        key: aliasKey,
        host: row.host,
        projects: [],
        brands: [cell]
      });
      return;
    }
    if (seen) seen.brands.push(cell);
    else
      machine.set(row.key, {
        name: row.name,
        key: row.key,
        host: row.host,
        projects: [],
        brands: [cell]
      });
  };

  for (const row of opts.rows) {
    if (row.entries.length) {
      putOnPages(pages, known, row, (root) => cellOf(row, { root }));
    } else {
      onto(row, cellOf(row));
    }
  }

  const repos = [...known.values()]
    .map((repo) => ({ repo, here: !!opts.ownRoot && sameRoot(repo.root, opts.ownRoot) }))
    .sort((a, b) => Number(b.here) - Number(a.here) || a.repo.label.localeCompare(b.repo.label))
    .map(({ repo, here }) => {
      const servers = pages.get(repo.root) ?? [];
      return {
        root: repo.root,
        label: repo.label,
        ...(repo.path ? { path: repo.path } : {}),
        ...(here ? { here: true } : {}),
        ...(servers.length ? {} : { emptyLine: EMPTY_LINE }),
        servers
      };
    });

  return machine.size ? [...repos, machineGroup([...machine.values()])] : repos;
}

/** `user` never reaches a repo page, so the chip is only `local` or `project`. */
function putOnPages(
  pages: Map<string, McpServerView[]>,
  known: Map<string, McpRepo>,
  row: McpRow,
  cellFor: (root: string) => McpBrandCell
): void {
  const roots = [...new Set(row.entries.map((entry) => entry.root))];
  for (const root of roots) {
    const page = pages.get(root);
    if (!page) continue;
    const scope = row.entries.find((entry) => entry.root === root)?.scope;
    const alsoIn = roots
      .filter((other) => other !== root)
      .map((other) => known.get(other)?.label ?? leaf(other));
    const cell = cellFor(root);
    const seen = page.find(
      (server) => server.key === row.key && !server.brands.some((c) => c.brand === cell.brand)
    );
    if (seen) {
      seen.brands.push(cell);
      continue;
    }
    page.push({
      name: row.name,
      key: page.some((s) => s.key === row.key)
        ? JSON.stringify([row.key, row.brand, row.name])
        : row.key,
      host: row.host,
      projects: [...row.projects],
      brands: [cell],
      ...(scope === 'local' || scope === 'project' ? { scope, scopeLabel: scope } : {}),
      ...(alsoIn.length ? { alsoIn } : {})
    });
  }
}

const machineGroup = (servers: McpServerView[]): McpGroupView => ({
  root: '',
  label: NO_REPO,
  path: NO_REPO_PATH,
  servers
});

function trailing(groups: McpGroupView[]): McpGroupView {
  const last = groups.find((group) => group.root === '');
  if (last) return last;
  const made = machineGroup([]);
  groups.push(made);
  return made;
}

/**
 * Two spellings of one directory.
 *
 * `os.tmpdir()` is `/var/folders/…`, a symlink to `/private/var/folders/…`, and
 * which of the two a root arrives as depends on who resolved it — git reports
 * the realpath, the workspace folder does not. A miss here shuts every section
 * including this window's, so it is worth the four lines
 * (`src/test/AGENTS.md`, the monorepo fixture's first trap).
 */
const sameRoot = (a: string, b: string): boolean => real(a) === real(b);

const real = (dir: string): string => (dir.startsWith('/private/') ? dir.slice(8) : dir);

function leaf(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/** A login retains its declaration after the displayed rows change. */
function overlayLive(servers: McpServerView[], live: McpLoginLive): void {
  if (!isBrand(live.target.brand)) return;
  // `done` is the login's last moment rather than a state on disk: the child
  // exited 0 and the credential is stored, but the files this sheet reads still
  // say `needs` until the health recheck lands a second or two later. Drawing
  // the cell connected now is what keeps an Authorise button from reappearing
  // under a reader who has just finished authorising.
  const state: McpBrandCell['state'] =
    live.phase === 'error' ? 'error' : live.phase === 'done' ? 'ok' : 'busy';
  const extra = {
    ...(live.note ? { note: live.note } : {}),
    ...(live.url ? { url: live.url } : {})
  };
  let hit = false;
  for (const server of servers) {
    const at = server.brands.findIndex(
      (c) =>
        c.brand === live.target.brand &&
        c.name === live.target.name &&
        !!c.target &&
        sameMcpRef(c.target, live.target)
    );
    if (at < 0) continue;
    const prev = server.brands[at];
    if (!prev) continue;
    hit = true;
    server.brands[at] = {
      ...prev,
      state,
      ...extra
    };
  }
  if (hit) return;
  // A login whose server has left the config still has a child. Keep Cancel.
  servers.push({
    name: live.target.name,
    key: JSON.stringify(['mcp-login', live.target]),
    host: '',
    projects: [],
    brands: [
      cellOf(
        {
          brand: live.target.brand,
          canLogin: live.target.canLogin,
          canDisconnect: live.target.canDisconnect,
          declarations: [{ sectionRoot: '', ref: live.target }],
          name: live.target.name,
          key: JSON.stringify(['mcp-login', live.target]),
          host: '',
          projects: [],
          entries: [],
          state: 'ok'
        },
        { state, ...extra }
      )
    ]
  });
}

/**
 * Whether the footer is asking for something the reader can do from here.
 *
 * `pending` and `unknown` are the two non-`ok` states that are not. A `pending`
 * server is answered by running `claude` in that repo, and nothing on this
 * surface does it; an `unknown` one has no reported problem at all, so amber
 * would be asking the reader to fix a reading we never took.
 */
export function summaryWants(servers: readonly McpServerView[]): boolean {
  return servers.some((s) =>
    s.brands.some((c) => c.state !== 'ok' && c.state !== 'pending' && c.state !== 'unknown')
  );
}

/** Rank actionable cells first so a buttonless `pending` row cannot mask one needing login. */
export function summaryOf(servers: readonly McpServerView[]): string | undefined {
  if (!servers.length) return undefined;
  const RANK: Record<McpBrandCell['state'], number> = {
    needs: 0,
    error: 1,
    busy: 2,
    broken: 3,
    pending: 4,
    unknown: 5,
    ok: 9
  };
  const wanting = servers
    .flatMap((server) => server.brands.map((cell) => ({ server, cell })))
    .filter(({ cell }) => cell.state !== 'ok')
    .sort((a, b) => RANK[a.cell.state] - RANK[b.cell.state])[0];
  if (!wanting) return 'All connected';

  const { server, cell } = wanting;
  const first = server.name[0];
  const who = first ? first.toUpperCase() + server.name.slice(1) : server.name;
  // Authorisation cannot fix unreachable or unapproved servers.
  if (cell.state === 'broken') return `${who} is unreachable`;
  if (cell.state === 'pending') return `${who} is not approved`;
  // Unknown status is no evidence of a problem.
  if (cell.state === 'unknown') return 'Status not checked';
  return `${who} needs ${cell.label}`;
}

/**
 * The line under the sheet head. Here rather than in `webview/` because every
 * version of it spells a CLI command, and the CLI's own words stay at this
 * seam. No sentence here names a surface of ours, per the glossary.
 */
function mcpHint(servers: readonly McpServerView[]): string {
  if (!servers.length) {
    return (
      'No MCP servers configured. Add one with claude mcp add in a repo, ' +
      'or grok mcp add, or codex mcp add, and it appears here.'
    );
  }
  if (servers.some((s) => s.brands.some((c) => c.brand === 'claude' && !c.supported))) {
    return 'Authorising Claude is not available on this host. Run claude mcp login in a terminal instead.';
  }
  return 'Each brand is its own login. Authorising Claude does not unlock Grok.';
}

export function healthRoots(
  rows: readonly McpRow[],
  roots: readonly string[],
  brand: BrandId
): string[] {
  const own = rows.filter((row) => row.brand === brand);
  // The roots that declare nothing are most of them — `roots` carries session
  // cwds and repo roots alike, ~25 on the machine this was written against, of
  // which 2 have a server. Asking the rest spends a child process on a certain
  // "no servers configured".
  const asking = [
    ...new Set(
      own.flatMap((row) =>
        row.declarations?.length
          ? row.declarations
              .filter((declaration) => declaration.ref.declaration.scope !== 'user')
              .map((declaration) => declaration.ref.readCwd)
          : row.entries.map((entry) => entry.root)
      )
    )
  ];
  // A user-scope row declares no root at all, and `mcp list` reports one from
  // every cwd — so it needs *some* root asked on its behalf or it can never be
  // anything but its cache state, which is the lie this step exists to end.
  if (!asking.length && own.length) {
    const anywhere = roots[0];
    if (anywhere) return [anywhere];
  }
  return asking;
}

/** Combine native snapshots, then remap presentation roots without changing refs. */
export function foldBoard(opts: {
  snapshots: readonly McpSnapshot[];
  board: McpBoard;
}): { rows: McpRow[] } | undefined {
  if (!opts.snapshots.some((snapshot) => snapshot.opensBoard)) return undefined;
  const repoOf = (root: string): string => opts.board.repoOf[root] ?? root;
  return {
    rows: opts.snapshots
      .flatMap((snapshot) => snapshot.rows)
      .map((row) => ({
        ...row,
        entries: row.entries.map((entry) =>
          entry.scope === 'project' ? { ...entry, root: repoOf(entry.root) } : entry
        ),
        ...(row.declarations
          ? {
              declarations: row.declarations.map((d) =>
                d.ref.declaration.scope === 'project'
                  ? { ...d, sectionRoot: repoOf(d.sectionRoot) }
                  : d
              )
            }
          : {})
      }))
  };
}
