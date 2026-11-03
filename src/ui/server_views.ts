/**
 * One repo's server rows, decided headlessly.
 *
 * `host/runs.ts` gathers `ServerContext`. This module turns that into the rows
 * a group shows, and says which repo a directory belongs to. `buildGroups`
 * asks both. Which sessions share a group stays in `views.ts`. Nothing here
 * polls, binds a port, or starts a process.
 */
import * as path from 'path';
import type { SessionListener } from '../core/devservers/listeners';
import type { Runner } from '../core/devservers/runners';
import type { Worktree } from '../core/git';
import type { RunningServer } from '../core/model';
import * as platform from '../core/platform';

/**
 * Servers context: trees and remembered ports are per repo; runners are per
 * tree, because worktrees can offer different scripts.
 */
export type ServerContext = {
  running: RunningServer[];
  /** repo root -> its working trees, `readWorktrees`. */
  trees: Map<string, Worktree[]>;
  /** tree path -> what can be started there, `resolveRunners`. */
  runners: Map<string, Runner[]>;
  /** repo root -> branch -> `rememberKey` -> the port it picked last. */
  remembered: Map<string, { [branch: string]: { [key: string]: number } }>;
  /**
   * The poll reads only the workspaces boolean; the sheet pays for the walk.
   * Keep an ambiguous monorepo root runnable so the sheet remains reachable.
   */
  workspaces: Set<string>;
  /** tree path -> the candidate scripts detection would not choose between,
   *  `candidateRunners`. Only ever set for a tree `runners` has no entry for:
   *  a directory that resolved to something is not ambiguous. */
  candidates: Map<string, string[]>;
  /**
   * The listeners this window's owned sessions are running, each placed in its
   * session's directory (`sessionListeners`, `core/devservers/listeners`). Which
   * tree that is happens here rather than host-side, for the rows' sake.
   */
  sessionServers: SessionListener[];
};

export const NO_SERVERS: ServerContext = {
  running: [],
  trees: new Map(),
  runners: new Map(),
  remembered: new Map(),
  workspaces: new Set(),
  candidates: new Map(),
  sessionServers: []
};

/**
 * macOS's ephemeral floor (`net.inet.ip.portrange.first`), and where Windows'
 * default dynamic range starts too.
 *
 * Exported for `runs.ts`, which asks it again of the process a ✕ names: this
 * module decides which listeners are drawable, and the stop has to refuse
 * everything that was not.
 */
export const EPHEMERAL_FLOOR = 49152;

/**
 * One row per branch, even with no process or runner.
 * Keep the remembered port for Run; unrunnable says there is nothing to start
 * rather than hiding a worktree.
 */
export function serverRows(repoRoot: string, servers: ServerContext): ServerRowView[] {
  const remembered = atRepo(servers.remembered, repoRoot) ?? {};
  const rows: ServerRowView[] = [];
  for (const tree of atRepo(servers.trees, repoRoot) ?? []) {
    const branch = tree.branch ?? path.basename(tree.path);
    const runners = servers.runners.get(tree.path) ?? [];
    if (!runners.length) {
      // Apps take the row; scripts remain in the sheet, so the tip must not disagree.
      const candidates = servers.workspaces.has(tree.path)
        ? undefined
        : servers.candidates.get(tree.path);
      rows.push({
        branch,
        tree: tree.path,
        cwd: tree.path,
        runnerId: '',
        // Match the sheet title to the word slot.
        label: candidates !== undefined ? 'pick a script here' : 'nothing to start here',
        unrunnable: true,
        ...(candidates !== undefined ? { candidates } : {}),
        // Apps below an empty root keep the row a button.
        ...(servers.workspaces.has(tree.path) ? { workspaces: true } : {})
      });
      continue;
    }
    for (const runner of runners) {
      const live = servers.running.find(
        (s) => samePath(s.cwd, tree.path) && s.runnerId === runner.id
      );
      rows.push({
        branch,
        tree: tree.path,
        cwd: tree.path,
        runnerId: runner.id,
        label: runner.label,
        ...(runner.guessed ? { guessed: true } : {}),
        ...(runner.portless ? { portless: true } : {}),
        ...(remembered[branch]?.[runner.id] !== undefined
          ? { remembered: remembered[branch]?.[runner.id] }
          : {}),
        ...(servers.workspaces.has(tree.path) ? { workspaces: true } : {}),
        ...(live ? liveHalf(live) : {})
      });
    }
  }

  // Keep unmatched live servers visible: their row is the way to stop them.
  for (const live of servers.running) {
    if (!samePath(repoOfTree(live.cwd, servers) ?? live.cwd, repoRoot)) {
      continue;
    }
    if (rows.some((row) => samePath(row.cwd, live.cwd) && row.runnerId === live.runnerId)) {
      continue;
    }
    rows.push({
      branch: live.branch ?? path.basename(live.cwd),
      tree: treeOf(live.cwd, servers)?.path ?? live.cwd,
      cwd: live.cwd,
      runnerId: live.runnerId,
      label: live.label,
      ...appOf(live.cwd, servers),
      ...liveHalf(live)
    });
  }

  sessionRows(repoRoot, servers, rows);

  // Put records and session servers first; status alone misses session servers.
  // Keep each half stable so chips do not move under the pointer.
  const live = (row: ServerRowView) =>
    Number(row.status !== undefined || row.listener !== undefined);
  return rows.sort((a, b) => live(b) - live(a));
}

/**
 * Find the repo from trees, not the registry. A server cwd can be a package
 * below a tree; missing containment would leave it with no row or stop button.
 */
export function repoOfTree(cwd: string, servers: ServerContext): string | undefined {
  // Keep two passes: one pass with || lets containment beat an exact repo, drawing twice.
  for (const [repoRoot, trees] of servers.trees) {
    if (trees.some((tree) => samePath(tree.path, cwd))) {
      return repoRoot;
    }
  }
  for (const [repoRoot, trees] of servers.trees) {
    if (trees.some((tree) => hosts(tree.path, cwd, servers))) {
      return repoRoot;
    }
  }
  return undefined;
}

/**
 * A repo's entry in the context. The host keys it by the spelling it read,
 * and a group may arrive spelled otherwise.
 */
function atRepo<V>(byRepo: ReadonlyMap<string, V>, repoRoot: string): V | undefined {
  const exact = byRepo.get(repoRoot);
  if (exact !== undefined) {
    return exact;
  }
  const want = platform.paths.key(repoRoot);
  for (const [root, value] of byRepo) {
    if (platform.paths.key(root) === want) {
      return value;
    }
  }
  return undefined;
}

function samePath(a: string, b: string): boolean {
  return platform.paths.key(a) === platform.paths.key(b);
}

/** Running fields from the registry, shared by branch and unmatched-server rows. */
function liveHalf(live: RunningServer): Partial<ServerRowView> {
  return {
    status: live.status,
    ...(live.port !== undefined ? { port: live.port } : {}),
    ...(live.url !== undefined ? { url: live.url } : {}),
    ...(live.reason !== undefined ? { reason: live.reason } : {})
  };
}

/** Fill existing rows with session servers, to avoid two chips on one branch. */
function sessionRows(repoRoot: string, servers: ServerContext, rows: ServerRowView[]): void {
  // One process is one server. Measured 2026-08-11: `workerd` serves
  // `apps/support-worker` on 8787 and binds 9229 for its V8 inspector — same
  // pid, same cwd, both plausible. Without this the inspector draws a second
  // chip for a server already on the line, and that shape ships with every
  // `wrangler dev` and every `node --inspect`. Lowest port wins: a debug port is
  // conventionally above the one being served.
  const lowest = new Map<number, SessionListener>();
  for (const heard of servers.sessionServers) {
    const held = lowest.get(heard.pid);
    if (!held || heard.port < held.port) {
      lowest.set(heard.pid, heard);
    }
  }

  for (const heard of [...lowest.values()].sort((a, b) => a.port - b.port)) {
    const cwd = placeOf(heard.cwd, servers);
    const repo = cwd === undefined ? undefined : repoOfTree(cwd, servers);
    if (cwd === undefined || repo === undefined || !samePath(repo, repoRoot)) {
      continue;
    }
    // A test runner or an inspector an agent left up on a port the OS picked.
    if (heard.port >= EPHEMERAL_FLOOR) {
      continue;
    }
    // Prefer our record, even when dead, or the branch draws twice.
    if (servers.running.some((live) => live.port === heard.port)) {
      continue;
    }

    const half = {
      port: heard.port,
      url: 'http://localhost:' + heard.port,
      listener: {
        command: heard.command ?? '',
        pid: heard.pid,
        startedAt: heard.startedAt,
        session: heard.session
      }
    };
    // Match a row that can hold a port, not cwd alone: resolveRunners can add a
    // portless dev host beside a runner in the same directory.
    const mine = rows.find(
      (row) =>
        samePath(row.cwd, cwd) &&
        !row.portless &&
        row.listener === undefined &&
        row.status === undefined &&
        row.port === undefined
    );
    if (mine) {
      Object.assign(mine, half);
      continue;
    }
    rows.push({
      // Use the containing tree's branch, or two worktrees serving the same app
      // would have indistinguishable chips.
      branch: treeOf(cwd, servers)?.branch ?? path.basename(cwd),
      tree: treeOf(cwd, servers)?.path ?? cwd,
      cwd,
      // No runner behind it, and the same value an `unrunnable` row carries —
      // which is why `srvKey` stands the port in for an empty `runnerId`, or the
      // two fold into one node under the morph.
      runnerId: '',
      label: heard.command ?? 'listening',
      ...appOf(cwd, servers),
      ...half
    });
  }
}

/**
 * Where a session's directory draws its server. `repoOfTree` takes a directory
 * below a tree only when that tree declares workspaces; a session started in a
 * plain repo's subdirectory has no such row, so its tree takes the chip.
 */
function placeOf(cwd: string, servers: ServerContext): string | undefined {
  if (repoOfTree(cwd, servers) !== undefined) return cwd;
  let best: string | undefined;
  for (const trees of servers.trees.values()) {
    for (const tree of trees) {
      if (
        platform.paths.contains(path.resolve(tree.path), path.resolve(cwd)) &&
        (best === undefined || tree.path.length > best.length)
      ) {
        best = tree.path;
      }
    }
  }
  return best;
}

/**
 * The app path below the longest declared containing tree.
 * Only live rows have an app; idle rows leave that choice to the sheet.
 */
function appOf(cwd: string, servers: ServerContext): { app?: string } {
  const tree = treeOf(cwd, servers);
  if (tree === undefined) {
    return {};
  }
  const rel = path.relative(tree.path, cwd);
  return rel ? { app: rel } : {};
}

/** The containing tree. Exact matches precede containment, for repoOfTree's reason. */
function treeOf(cwd: string, servers: ServerContext): Worktree | undefined {
  let best: Worktree | undefined;
  for (const trees of servers.trees.values()) {
    for (const tree of trees) {
      if (samePath(tree.path, cwd)) {
        return tree;
      }
      // Use the nearest tree for an app inside a nested worktree.
      if (
        hosts(tree.path, cwd, servers) &&
        (best === undefined || tree.path.length > best.path.length)
      ) {
        best = tree;
      }
    }
  }
  return best;
}

/**
 * Only declared workspaces can have packages: plain containment would read an
 * undiscovered nested worktree as an app. A monorepo's own nested worktree can
 * still read as an app for one poll, until discovery gives it a row.
 */
function hosts(tree: string, cwd: string, servers: ServerContext): boolean {
  const rel = path.relative(platform.paths.key(tree), platform.paths.key(cwd));
  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    !path.isAbsolute(rel) &&
    servers.workspaces.has(tree) &&
    platform.paths.contains(path.resolve(tree), path.resolve(cwd))
  );
}
