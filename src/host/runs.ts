import * as path from 'path';
import * as vscode from 'vscode';
import { RunningServer, Session, WindowClaim } from '../core/model';
import {
  free,
  occupancyOf,
  probe,
  readPorts,
  rememberKey,
  RepoPorts,
  resolveBlock,
  rememberPort,
  sheetPorts
} from '../core/devservers/ports';
import {
  drawnHere,
  IN_USE,
  judgeServer,
  keepServer,
  probeable,
  readServers,
  reconcileServers,
  removeServer,
  reviseServer,
  touchServer,
  writeServer
} from '../core/devservers/servers';
import {
  PackageJson,
  Runner,
  RunnerOffer,
  candidateRunners,
  resolveRunners
} from '../core/devservers/runners';
import { Reply } from '../core/coordination/requests';
import {
  PNPM_WORKSPACE_FILE,
  declaresWorkspaces,
  projectDirs
} from '../core/devservers/workspaces';
import {
  type PinnedSocket,
  listeners,
  pinned,
  sessionListeners,
  sockets,
  stoppable
} from '../core/devservers/listeners';
import { closeTree, snapshotTree } from '../core/control';
import { scanProcesses } from '../core/scan';
import { readJson, writtenAt } from '../core/files';
import { readCheckout, readWorktrees } from '../core/git';
import * as platform from '../core/platform';
import type { PathKey } from '../core/platform/paths';
import { EPHEMERAL_FLOOR, type ServerContext } from '../ui/server_views';
import { groupKey } from '../ui/views';
import { heldServers, holdsServer, startServer, stopServer } from './terminal';
import { ideCliPath } from './windows';
import { PanelActions } from './panel_actions';
export type RunSettings = {
  commands: { [cwd: string]: Runner[] };
  detect: boolean;
  ideCli?: string;
};

/**
 * How long a dev server is given to answer on the port it was asked for, and how
 * often it is asked. Vite and Next both bind in well under a second cold; twenty
 * seconds is a slow install or a compile step ahead of the serve, and past that
 * the honest answer is that our port is not where it landed.
 */
const SERVER_READY_MS = 20_000;
const SERVER_POLL_MS = 500;

/**
 * How long a stopped port is waited on before the run sheet is told what is on
 * the block, and how often it is asked.
 *
 * Disposing a terminal signals the shell, and the process holding the socket
 * dies a beat after that — measured in the smoke suite, which had to wait for
 * the port rather than the chip for the same reason. Four seconds is far past
 * that beat and still short of a reader wondering whether the button worked.
 */
const PORT_RELEASE_MS = 4_000;
const PORT_POLL_MS = 250;

/**
 * How stale the listener reading may get before another is started, and how
 * stale it may get before it stops being drawn at all.
 *
 * Two spawns is 46ms on a quiet machine, so 7s is roughly one reading per two
 * polls — a hand-started server appears within about ten seconds, which is the
 * cadence a person who just typed `npm run dev` and switched windows expects.
 *
 * The ceiling is the same rule the empty map is: a reading nobody has refreshed
 * for a minute is not evidence, and drawing a port that nothing holds is worse
 * than drawing none. A
 * panel hidden for twenty minutes comes back with no chips rather than with
 * twenty-minute-old ones, and fills in on the next poll.
 */
const LISTENERS_MS = 7_000;
const LISTENERS_STALE_MS = 60_000;

/**
 * How long a reading may be in flight before the next caller gives up on it and
 * starts one of its own — the horizon that keeps `inflight` from being
 * permanent, and `heardListeners` is where it is argued for.
 *
 * The draw ceiling, because the flag may not be the reason a chip is missing: it
 * lets go exactly when the reading it is holding stops being drawable. **Floored
 * above the pacing interval, and that floor is why this is a derivation rather
 * than a reuse** — lower `LISTENERS_STALE_MS` for its own reason, deciding that
 * minute-old port evidence is worse than it looked, and the bare ceiling would
 * invert the guard: an in-flight reading would become restartable sooner than an
 * idle one, and the flag would make the pile-up worse than no flag at all.
 *
 * The floor clears a second thing, and that is what the multiple is for: at any
 * sane `LISTENERS_MS` it also clears the ~4s two honest spawns cost
 * (`2 × SPAWN_MS`, `core/devservers/listeners.ts`), which it must, or a reading that is
 * merely slow gets abandoned and duplicated instead of waited for — the pile-up
 * this whole guard exists to stop. `SPAWN_MS` is not exported and importing it
 * across the seam to floor this would cost more than the margin buys.
 */
const LISTENERS_WEDGE_MS = Math.max(2 * LISTENERS_MS, LISTENERS_STALE_MS);

/**
 * The listener reading, kept off the poll's critical path.
 *
 * **Nothing here is awaited.** `serverContext` runs inside the poll's
 * `Promise.all`, so awaiting a fresh reading would hold the whole board push —
 * every card, not just the chips — behind two walks of the process table. This
 * poll draws what the last reading found; the next one draws this one's.
 *
 * That makes the pacing the load-bearing part, and it takes two guards. The
 * clock is stamped before the await, never on resolve — two `execFile`s back
 * off `SPAWN_MS` each, so a wedged `lsof` is 4s against a 3s poll, and stamping
 * on resolve would let every poll the slow pair outlives start another one
 * behind it. But a clock bounds only how *often* a reading may begin: past
 * `LISTENERS_MS` the stamp is spent and the next caller starts a second pair
 * whether or not the first has landed. On a machine loaded enough for `lsof` to
 * take longer than that — the only machine where any of this matters — one more
 * pair joins per `LISTENERS_MS` of overrun, each of them two more spawns
 * against the load already slowing them.
 *
 * **`inflight` therefore expires, on `LISTENERS_WEDGE_MS`.** A bare flag cannot:
 * `execFile`'s timeout signals the child and the promise settles on its *exit*,
 * so a child that does not die on `SIGTERM` — the wedged mount `SPAWN_MS` is a
 * backstop for — settles nothing, and the flag would be held for the panel's
 * life. Past `LISTENERS_STALE_MS` that is every session server's chip gone from the board
 * until the panel is closed and reopened: the cache is built on first call, and
 * only a new `OverviewPanel` has a fresh one.
 *
 * **A reading abandoned that way is abandoned in both halves**, and the flag is
 * the lesser one. Its answer is as old as it is, and a killed `lsof` answers
 * `''` — so left ungated its `then` would write an *empty* map over whatever its
 * successor had just landed, and stamp `foundAt` fresh doing it, which is the
 * one thing `LISTENERS_STALE_MS` exists to prevent. Both halves therefore check
 * the stamp they were started under, for the reason `touchHeldServers` re-reads
 * `written`.
 *
 * A boolean rather than the promise cache `scan.ts` keeps, because nothing here
 * awaits the answer. What that cache gets for free is the expiry above — being
 * keyed on a clock, a scan that never settles is abandoned rather than
 * remembered.
 *
 * `performance.now()` for the clock, per `scan.ts`: a backward NTP or
 * VM-snapshot step pins a wall-clock cache for the size of the step.
 */
function heardListeners(panel: PanelActions): PinnedSocket[] {
  const cache = (panel.listeners ??= {
    startedAt: -Infinity,
    foundAt: -Infinity,
    inflight: false,
    found: []
  });
  const now = performance.now();
  if (now - cache.startedAt > (cache.inflight ? LISTENERS_WEDGE_MS : LISTENERS_MS)) {
    cache.startedAt = now;
    cache.inflight = true;
    // Machine-wide: the board holds several repos and cannot name one block, and
    // the unbounded reading is the cheaper of the two anyway.
    void sockets()
      .then(async (read) => ({ read, table: await scanProcesses() }))
      .then(({ read, table }) => {
        // Abandoned as wedged: a successor was started under a newer stamp, and
        // this answer is at least `LISTENERS_WEDGE_MS` old. The header says why
        // an old answer here is worse than none.
        if (cache.startedAt !== now) {
          return;
        }
        // An empty map is an answer and replaces the last one. `core/devservers/listeners.ts`
        // refuses to tell "nothing is bound" from "the reading failed", and
        // keeping the last map on a failure would draw a chip for a server that
        // has stopped.
        cache.found = pinned(read.values(), table);
        cache.foundAt = performance.now();
      })
      // For the `then` above and nothing else: `lsof()` answers with a string
      // however it went — `''` for a missing binary or a timeout, whatever it
      // managed for a denied read — so `listeners()` has no reachable rejection
      // of its own. Kept anyway: a `void`ed chain that grows one becomes an
      // unhandled rejection rather than a quiet miss.
      .catch(() => undefined)
      // `finally` and not the `then` above, so the clear does not depend on the
      // `catch` staying there. Same stamp test, for the same reason.
      .finally(() => {
        if (cache.startedAt === now) {
          cache.inflight = false;
        }
      });
  }
  // The previous reading survives the one now in flight — replacing it here
  // would blink every chip off for a poll and back on for the next.
  return now - cache.foundAt <= LISTENERS_STALE_MS ? cache.found : [];
}

/** Read settings per call so changes reach the next poll without a restart. */
export async function runSettings(): Promise<RunSettings> {
  const config = vscode.workspace.getConfiguration('squadron');
  return {
    commands: config.get<{ [cwd: string]: Runner[] }>('run.commands', {}),
    detect: config.get<boolean>('run.detect', true),
    // Read, never written down: the launcher is named after whatever fork this
    // is running in. Absent leaves the dev-host runner unoffered.
    ideCli: await ideCliPath()
  };
}

/** Fallback, never a merge: `offersFor` fills at most one of the two lists. */
async function offerableRunners(
  panel: PanelActions,
  cwd: string,
  settings: RunSettings
): Promise<Runner[]> {
  const { runners, candidates } = await offersFor(panel, cwd, settings);
  return runners.length ? runners : candidates;
}

/**
 * What a directory can be told to start, remembered against its
 * `package.json`'s mtime.
 *
 * The PRD's rule is that detection reads `package.json` on click and never on
 * the poll, and the reason is cost: a repo with six worktrees is six reads and
 * six parses every three seconds. A `stat` answers the same question — the
 * file is on disk and nothing here can be told when it changes — so the poll
 * pays one stat per tree and re-reads only what has actually been edited.
 * Settings are part of the key for the same reason: naming a command must
 * reach the board on the next poll, not on the next mtime.
 *
 * All three answers come off the one parse, which is why they share a cache
 * entry rather than being read three times. The `pnpm-workspace.yaml` mtime is
 * in the key as well as `package.json`'s — a repo that grows a pnpm manifest
 * without touching its `package.json` would otherwise keep answering "no
 * workspaces" until something else edited the file.
 *
 * `workspaces` is the cheap question and the only one the poll asks. Which
 * directories those are is a walk, and it happens when the sheet opens.
 */
export async function offersFor(
  panel: PanelActions,
  cwd: string,
  settings: RunSettings
): Promise<RunnerOffer> {
  const file = path.join(cwd, 'package.json');
  const [at, pnpmAt] = await Promise.all([
    writtenAt(file),
    writtenAt(path.join(cwd, PNPM_WORKSPACE_FILE))
  ]);
  const key = `${at ?? 0} ${pnpmAt ?? 0} ${JSON.stringify(settings)}`;
  const seen = panel.runners.get(cwd);
  if (seen?.key === key) {
    return seen;
  }
  const pkg = await readJson<PackageJson>(file);
  const runners = resolveRunners(cwd, settings, pkg);
  const offer = {
    key,
    runners,
    workspaces: declaresWorkspaces(pkg, pnpmAt !== undefined),
    // Only where nothing resolved. A directory the reader named a command for,
    // or one detection read outright, has no question left to ask — and
    // `detect: false` means this file was not to be read for scripts at all.
    candidates: runners.length || settings.detect === false ? [] : candidateRunners(pkg)
  };
  panel.runners.set(cwd, offer);
  return offer;
}

/**
 * Everything the servers section is drawn from, for every group on the board.
 *
 * One `readdir` of `.git/worktrees`, one `package.json` per tree and one ports
 * file per repo, on the poll that already reads `lineage/`, `windows/` and
 * `live/`. **No bind test happens here** — occupancy is ten sockets, and it is
 * paid for when a picker opens (`openRunPicker`) and never on the poll.
 */
export async function serverContext(
  panel: PanelActions,
  sessions: Session[],
  claims: WindowClaim[],
  folder: string | undefined,
  folderRoots: Map<string, string>,
  scratchRoot?: string
): Promise<ServerContext> {
  // The same keys `buildGroups` groups by — a context keyed differently would
  // attach a repo's trees to no group at all. The first spelling is read.
  const roots = new Map<PathKey, string>();
  const add = (root: string) => {
    const key = platform.paths.key(root);
    if (!roots.has(key)) roots.set(key, root);
  };
  for (const session of sessions) {
    add(groupKey(session, scratchRoot));
  }
  // folderRoots holds worktrees only. Fall back to claim.folder so an ordinary
  // checkout gets a section even when no session is running there.
  for (const claim of claims) {
    if (claim.folder) {
      add(folderRoots.get(claim.folder) ?? claim.folder);
    }
  }
  if (folder) {
    add(folderRoots.get(folder) ?? folder);
  } else if (scratchRoot) {
    add(scratchRoot);
  }

  const settings = await runSettings();

  const context: ServerContext = {
    running: (await liveServers()).filter((s) =>
      drawnHere(s, { windowId: vscode.env.sessionId, holds: holdsServer })
    ),
    trees: new Map(),
    runners: new Map(),
    remembered: new Map(),
    workspaces: new Set(),
    candidates: new Map(),
    sessionServers: sessions.some(({ source, background }) => source === 'owned' && !background)
      ? sessionListeners(heardListeners(panel), sessions, await scanProcesses())
      : []
  };
  await Promise.all(
    [...roots.values()].map(async (root) => {
      const [trees, ports] = await Promise.all([readWorktrees(root), readPorts(root)]);
      if (trees.length === 0) {
        return; // not a repository — no branches, so no section
      }
      context.trees.set(root, trees);
      context.remembered.set(root, ports.lastUsed);
      await Promise.all(
        trees.map(async (tree) => {
          const { runners, workspaces, candidates } = await offersFor(panel, tree.path, settings);
          if (runners.length) {
            context.runners.set(tree.path, runners);
          }
          if (workspaces) {
            context.workspaces.add(tree.path);
          }
          if (candidates.length) {
            context.candidates.set(
              tree.path,
              candidates.map((runner) => runner.id)
            );
          }
        })
      );
    })
  );
  return context;
}

/**
 * What this window last wrote for each server it started, so `touchHeldServers`
 * can put back a record that was swept while the terminal kept running. Keyed
 * as `terminal.ts` keys its own map, and pruned there against it — a key that
 * has left `heldServers()` is a server this window no longer holds.
 */
const written = new Map<string, RunningServer>();
// `\u0000` must match terminal.ts: cwd can contain spaces and runner ids need
// only be non-empty. Spell the escape because the byte looks like a space in diffs.
const recordKey = (cwd: string, runnerId: string) => `${platform.paths.key(cwd)}\u0000${runnerId}`;

/**
 * How many probes in a row a held server has failed to answer, keyed as
 * `written` is and pruned with it.
 *
 * **The count belongs to the record, so every write clears it.** *Run* on a
 * chip that just died writes a fresh record under the same key, and strikes
 * carried into it would kill the new server on its first missed probe.
 */
const silent = new Map<string, number>();

async function writeAndKeep(server: RunningServer): Promise<void> {
  remember(server);
  await writeServer(server);
}

/**
 * `writeAndKeep` for the heartbeat, which may not write over a record that is
 * no longer ours — `reviseServer` says which two those are. It remembers only
 * what it managed to write, so a refusal leaves this window's memory agreeing
 * with the disk rather than with what it hoped for.
 */
async function reviseAndKeep(server: RunningServer): Promise<void> {
  if (await reviseServer(server)) {
    remember(server);
  }
}

function remember(server: RunningServer): void {
  const key = recordKey(server.cwd, server.runnerId);
  written.set(key, server);
  silent.delete(key);
}

/**
 * Whether the listener on a record's port is that record's own server.
 *
 * **A connect answers "something is there", and a revival needs "ours is
 * there".** Demotion can live with the weaker question — a silent port is
 * nobody's server, so the worst a wrong answer costs is a chip that goes dead
 * early. Promotion cannot: it repaints the chip green and points its body at a
 * URL, and our port is freed the moment our server dies, so anything at all may
 * be answering there by the time we ask. `ports.ts` names that outcome the one
 * thing this feature exists to never do.
 *
 * `lsof`'s cwd is what settles it, and it comes back as `RunningServer.cwd`
 * verbatim (`core/devservers/listeners.ts`), so this is a lookup rather than a guess. An
 * unattributed listener — the second reading failed, or `lsof` is not on this
 * machine — is not proof, and the record stays dead.
 *
 * **Compared as strings, and `lsof` resolves where we do not.** A tree reached
 * through a symlink — anything under `/tmp` on macOS — is `/private/var/…` to
 * `lsof` and whatever it was handed to us, so the compare misses and revival
 * never fires. Measured 2026-08-11 and written up on the scenario that dodges
 * it (`test/smoke/servers.smoke.ts`). Left alone rather than realpath'd here:
 * `sessionRows` joins the same field the same way (`repoOfTree`, `ui/server_views.ts`),
 * so this is one instance of a tree-wide trap and closing it in one join would
 * leave the two disagreeing about which paths match. It misses in the safe
 * direction — a chip that stays dead, never one that wrongly goes green — and a
 * revival scenario written against an un-realpathed fixture will look like the
 * rule is broken when it is the fixture.
 *
 * Uncached and unpaced, unlike `heardListeners`: this asks only on the rare
 * path where a record we called dead has answered, so a reading of its own is
 * cheaper than keeping one warm for it.
 */
async function servedFromHere(server: RunningServer & { port: number }): Promise<boolean> {
  const heard = (await listeners()).get(server.port);
  return (
    heard?.cwd !== undefined && platform.paths.key(heard.cwd) === platform.paths.key(server.cwd)
  );
}

/**
 * Drive the heartbeat from held terminals, independently of the panel: polling
 * stops while the panel is hidden and would let a running server's record expire.
 *
 * heldServers chooses ownership. Its keys exist only after startServer creates
 * a terminal, so no reservation/terminal settle guard is needed here.
 * probeable decides which held records may be probed.
 */
export async function touchHeldServers(): Promise<void> {
  const held = heldServers();
  const live = new Set(held.map(({ cwd, runnerId }) => recordKey(cwd, runnerId)));
  for (const key of written.keys()) {
    if (!live.has(key)) {
      written.delete(key);
      silent.delete(key);
    }
  }
  await Promise.all(
    held.map(async ({ cwd, runnerId }) => {
      const key = recordKey(cwd, runnerId);
      const last = written.get(key);
      if (!last) {
        // Only reachable for a start whose key was pruned in the microseconds
        // between `writeAndKeep` remembering it and `startServer` making the
        // terminal. Not the reload case, whatever it looks like: `written` and
        // `serverTerminals` are module state in one extension host and go
        // together, so after a reload `heldServers()` is empty and this loop
        // does not run at all — `liveServers` forgets those records instead.
        await touchServer(cwd, runnerId);
        return;
      }
      // The rule, and every reason behind it: `probeable` and `judgeServer`
      // (`core/devservers/servers.ts`).
      //
      // Nothing is refreshed: this runs on its own interval with no panel to
      // reach, and the poll reads the record off disk a tick after it changes.
      if (probeable(last)) {
        const answered = await probe(last.port);
        // **Both guards are about what moved while the probe was in flight**,
        // and neither is the other's spelling. `written` is re-read because a
        // stop and then a *Run* inside those milliseconds puts a different
        // record under this key, and a strike earned by the old server's port
        // must not land on the new one. `holdsServer` is re-asked for
        // `keepServer`'s reason. Neither closes its race — `reviseServer` is
        // what does, by refusing to write a record that is gone.
        if (written.get(key) === last) {
          const { misses, next } = judgeServer(last, answered, silent.get(key) ?? 0);
          silent.set(key, misses);
          // A revival by construction: a record already `up` and answering
          // produces no `next` at all, so the only way to reach `up` here is
          // from the dead.
          const revival = next?.status === 'up';
          if (next && holdsServer(cwd, runnerId) && (!revival || (await servedFromHere(last)))) {
            // The terminal is left open on a death: it holds the output that
            // says why, and the chip keeps its ✕ for whoever has read it.
            await reviseAndKeep(next);
            return;
          }
        }
      }
      // Handed in rather than checked here: everything above runs in the same
      // synchronous turn as `heldServers()`, so a check on this line could
      // never disagree with it. `keepServer` re-asks it after its own read,
      // which is where a stop can actually land.
      await keepServer(last, () => holdsServer(cwd, runnerId));
    })
  );
}

/**
 * reconcileServers owns removal. touchHeldServers keeps held records alive
 * whether or not the panel is visible.
 */
export async function liveServers(): Promise<RunningServer[]> {
  const { remove, keep } = reconcileServers(await readServers(), {
    windowId: vscode.env.sessionId,
    holds: holdsServer,
    now: Date.now()
  });
  await Promise.all(remove.map((server) => forget(server.cwd, server.runnerId)));
  return keep;
}

async function forget(cwd: string, runnerId: string): Promise<void> {
  const key = recordKey(cwd, runnerId);
  written.delete(key);
  // Both maps, or this one is unreachable: the prune in `touchHeldServers`
  // walks `written`, so a key dropped from there alone can never be visited
  // again.
  silent.delete(key);
  await removeServer(cwd, runnerId);
}

/**
 * Answers a picker with what is on this repo's block. The bind test lives
 * here, on open, for the reason `listConversations` is asked for on open: it
 * is real work, and a three-second repaint has no business doing it.
 *
 * A port a registry entry has reserved is unfree too, named by its branch —
 * that is what stops two windows picking the same port in the seconds before
 * either server answers.
 *
 * **This is also the one place workspaces are walked.** `projectDirs` reads
 * the tree's manifests and stats each declared directory; it is the same slot
 * the bind tests are paid for in, and it never happens on the poll.
 */
export async function openRunPicker(
  panel: PanelActions,
  cwd: string,
  tree: string,
  branch: string,
  runnerId?: string
): Promise<void> {
  // What a stop re-answers. Occupancy is only ever posted from here, so a
  // sheet that stops the server holding a port would sit on that answer
  // forever without it — the tile it just freed still reading as held.
  panel.lastRunPicker = { cwd, tree, branch, runnerId };
  // The tree's repo, not the row's. For a server running in a package these
  // resolve to the same `.git` — but the keys under it are composed against
  // `tree`, and reading them against anything else finds another start's port.
  const checkout = await readCheckout(tree);
  const repoRoot = checkout?.repoRoot ?? tree;
  const [ports, running] = await Promise.all([readPorts(repoRoot), readServers()]);
  // Who holds each port and how to stop them, in one map: the name and the
  // key are read from one record, and two maps filled by one `if` is a
  // divergence waiting for the day there are two.
  //
  // Only registry holders get an entry. A port some other program on the
  // machine is listening on is drawn as taken and offers no button, because
  // there is nothing of ours behind it to send `stopRun` to.
  const held = new Map<number, { label: string; cwd: string; runnerId: string }>();
  for (const server of running) {
    if (
      server.port !== undefined &&
      !(platform.paths.key(server.cwd) === platform.paths.key(cwd) && server.runnerId === runnerId)
    ) {
      held.set(server.port, {
        label: server.branch ?? path.basename(server.cwd),
        cwd: server.cwd,
        runnerId: server.runnerId
      });
    }
  }
  // After the starts, not beside them: which blocks to bind-test is theirs to
  // say. The extra serial step is one `package.json` read `offersFor` has
  // usually cached; the bind tests dominate.
  const starts = await startsFor(panel, tree, ports);
  const lastUsed = ports.lastUsed[branch] ?? {};
  const status = await occupancyOf(
    sheetPorts(starts, lastUsed),
    new Map([...held].map(([port, who]) => [port, who.label]))
  );
  panel.post({
    type: 'ports',
    cwd,
    branch,
    runnerId: runnerId ?? '',
    // Into the wire's three cases. `occupancy` says free or not; this says
    // which kind of not-free, which is the only thing the sheet draws
    // differently.
    ports: status.map((port) => {
      const who = held.get(port.port);
      if (port.free) {
        return { port: port.port, free: true as const };
      }
      return who
        ? {
            port: port.port,
            free: false as const,
            heldBy: who.label,
            holder: { cwd: who.cwd, runnerId: who.runnerId }
          }
        : { port: port.port, free: false as const };
    }),
    starts,
    // The whole branch's map, not one port: the default belongs to the start,
    // and the sheet is what knows which start is picked. A remembered port
    // that has since been taken is greyed out there like any other (A17).
    lastUsed
  });
}

/**
 * Omit workspace packages with no resolved runner, as for a plain repo.
 * Only the tree's own candidates are offered: its chip asked the question.
 * Each start carries the block `resolveBlock` gives it out of `ports`.
 */
export async function startsFor(
  panel: PanelActions,
  tree: string,
  ports: RepoPorts
): Promise<RunStart[]> {
  const settings = await runSettings();
  const pkg = await readJson<PackageJson>(path.join(tree, 'package.json'));
  const dirs = await projectDirs(tree, pkg);
  const starts: RunStart[] = [];
  for (const dir of dirs) {
    const rel = path.relative(tree, dir);
    const offered =
      platform.paths.key(dir) === platform.paths.key(tree)
        ? await offerableRunners(panel, dir, settings)
        : (await offersFor(panel, dir, settings)).runners;
    for (const runner of offered) {
      starts.push({
        cwd: dir,
        runnerId: runner.id,
        // The tree's own runners keep their bare label — there is no app to
        // name, and a repo with no workspaces must read exactly as before.
        label: rel ? `${rel} · ${runner.label}` : runner.label,
        key: rememberKey(tree, dir, runner.id),
        ...(runner.portless
          ? { portless: true }
          : { block: resolveBlock(ports, runner.defaultPort) }),
        ...(runner.guessed ? { guessed: true } : {})
      });
    }
  }
  return starts;
}

/**
 * Starts one in this window, and returns as soon as the terminal exists.
 *
 * The `starting` record is written **before** the spawn, so another window's
 * picker sees the port taken in the seconds before anything is listening on it.
 *
 * Terminal output is never read: if the port we asked for never answers, the
 * row says `failed · port taken` rather than guessing where the server landed.
 * A port already bound or reserved at the press fails as `port in use` before
 * anything is spawned: `awaitReady`'s probe cannot tell its listener from ours,
 * and would draw the row `up` at the other program's URL.
 */
export async function runServerHere(
  host: PanelActions,
  cwd: string,
  tree: string,
  runnerId: string,
  branch: string,
  port?: number
): Promise<Reply> {
  const runner = (await offerableRunners(host, cwd, await runSettings())).find(
    (r) => r.id === runnerId
  );
  if (!runner) {
    return { ok: false, reason: 'That runner is not offered in this window.' };
  }

  // The repo is the tree's, not the app's: `readCheckout` of a package
  // directory walks up to the same `.git` anyway, but the branch a port is
  // remembered under belongs to the worktree and asking the tree says so.
  const checkout = await readCheckout(tree);
  const app = path.relative(tree, cwd);
  const started = Date.now();
  const record = {
    cwd,
    runnerId,
    label: runner.label,
    branch,
    windowId: vscode.env.sessionId,
    ...(port !== undefined ? { port } : {}),
    status: 'starting' as const,
    startedAt: started,
    updatedAt: started
  };
  if (port !== undefined && !runner.portless && (await taken(port, cwd, runnerId))) {
    // No port on it: nothing of ours holds that one, and a record naming it
    // would draw it held by this branch in every other sheet.
    const { port: _, ...unbound } = record;
    await writeAndKeep({ ...unbound, status: 'failed', reason: IN_USE });
    void host.refresh();
    return { ok: true };
  }
  await writeAndKeep(record);
  startServer(cwd, runner, port, branch, app || undefined);
  if (port !== undefined) {
    await rememberPort(checkout?.repoRoot ?? tree, branch, rememberKey(tree, cwd, runnerId), port);
  }
  void host.refresh();

  // A portless runner — the extension dev host — has nothing to probe: it
  // opens a window, and the terminal existing is the whole of "it started".
  if (runner.portless || port === undefined) {
    await writeAndKeep({ ...record, status: 'up' });
    void host.refresh();
    return { ok: true };
  }

  // Never awaited: the terminal exists, which is what the caller is waiting to
  // hear, and `awaitReady` is allowed twenty seconds.
  void awaitReady(host, record, port);
  return { ok: true };
}

/** Whether something else has the port: a listener, or another start's
 *  reservation that has not bound yet. A failed record holds nothing. */
async function taken(port: number, cwd: string, runnerId: string): Promise<boolean> {
  const claims = new Map<number, string>();
  for (const server of await readServers()) {
    const self =
      platform.paths.key(server.cwd) === platform.paths.key(cwd) && server.runnerId === runnerId;
    if (server.port === port && server.status !== 'failed' && !self) {
      claims.set(port, server.branch ?? server.cwd);
    }
  }
  const [status] = await occupancyOf([port], claims);
  return status?.free !== true;
}

async function awaitReady(host: PanelActions, record: RunningServer, port: number): Promise<void> {
  for (let waited = 0; waited < SERVER_READY_MS; waited += SERVER_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, SERVER_POLL_MS));
    // Stopped, or its terminal closed, while we were waiting.
    if (!holdsServer(record.cwd, record.runnerId)) {
      return;
    }
    if (await probe(port)) {
      await writeAndKeep({ ...record, status: 'up', url: `http://localhost:${port}` });
      void host.refresh();
      return;
    }
  }
  await writeAndKeep({ ...record, status: 'failed', reason: 'port taken' });
  void host.refresh();
}

/**
 * Occupancy again, for the sheet that is open — after a stop it asked for.
 *
 * A no-op before any sheet has been opened, and harmless after one has shut:
 * the webview drops an answer it did not ask for on the same check that drops
 * one belonging to the previous row.
 *
 * **The socket outlives the terminal**, so this waits for the port it stopped
 * before asking. Disposing a terminal signals the shell and the process holding
 * the port dies a beat later; answering inside that beat draws the port as
 * still taken, and since nothing else ever posts occupancy the sheet would sit
 * on that answer until it was closed and reopened — the dead end the tile's
 * *Stop* exists to remove. `PORT_RELEASE_MS` is the cap: past it the answer
 * goes out anyway, saying what is true rather than what was hoped for.
 */
export async function reanswerRunPicker(panel: PanelActions, port?: number): Promise<void> {
  const last = panel.lastRunPicker;
  if (!last) return;
  if (port !== undefined) {
    const until = Date.now() + PORT_RELEASE_MS;
    while (Date.now() < until && !(await free(port))) {
      await new Promise((resolve) => setTimeout(resolve, PORT_POLL_MS));
    }
  }
  await openRunPicker(panel, last.cwd, last.tree, last.branch, last.runnerId);
}

/**
 * Stops a server whose terminal this window holds, and drops any other record.
 */
export async function stopRun(
  panel: PanelActions,
  cwd: string,
  runnerId: string
): Promise<number | undefined> {
  // Read before anything is stopped, and returned rather than used here: the
  // run sheet may be open on this port, and what it needs is the number, not
  // the record — which is about to stop existing.
  const record = (await readServers()).find(
    (server) =>
      platform.paths.key(server.cwd) === platform.paths.key(cwd) && server.runnerId === runnerId
  );
  if (holdsServer(cwd, runnerId)) {
    stopServer(cwd, runnerId);
    await forget(cwd, runnerId);
    void unheard(panel, record?.port);
    void panel.refresh();
    return record?.port;
  }
  if (!record) {
    // Nothing holds it: the record went stale, or its window has gone. The
    // sweep on read is what takes the row away.
    void panel.refresh();
    return;
  }
  // A record this window holds no terminal for — another window's, or one of
  // ours the heartbeat has already lost. **Drop it, and signal nothing.** A
  // record carries no pid (`RunningServer`), so the only thing to signal would be
  // whatever is on the port *now*, and anything may have taken it: a record
  // survives `SERVER_STALE_MS` after its window is gone.
  await removeServer(cwd, runnerId);
  void unheard(panel, record.port);
  void panel.refresh();
  return record.port;
}

/**
 * Drops a server we just stopped from the listener reading — `killListener`'s
 * last step, owed to our own stops for the same reason and not paid until now.
 *
 * The record goes the instant the terminal does, while the reading is up to
 * `LISTENERS_MS` old plus the poll that draws it. A stale reading stops being
 * used for a stopped server as soon as its socket frees.
 *
 * By port and not by pid, which is the one difference from `killListener`: a
 * record names the port it was reserved on and never the process that took it.
 * That is enough — a listener on a port a record of ours held is that record's,
 * and the reading is replaced wholesale within `LISTENERS_MS` either way.
 *
 * **Only once the socket is actually free**, for `killListener`'s reason: a
 * process that sat through its stop is a process still serving, and dropping it
 * here would blank a live chip until the next reading put it straight back. Past
 * `PORT_RELEASE_MS` the reading is left alone and a listener that outlived its
 * stop draws as what it now is.
 *
 * Not awaited by any caller. The refresh beside each of them takes the record's
 * own row away now; this is only about what the *next* poll draws, and awaiting
 * it would hold the stop for the length of the release beat.
 */
async function unheard(panel: PanelActions, port: number | undefined): Promise<void> {
  if (port === undefined) return;
  const until = Date.now() + PORT_RELEASE_MS;
  let released = await free(port);
  while (!released && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, PORT_POLL_MS));
    released = await free(port);
  }
  const cache = panel.listeners;
  if (!released || !cache) return;
  cache.found = cache.found.filter((heard) => heard.port !== port);
  void panel.refresh();
}

/**
 * Ends a server an owned session is running — the ✕ on its chip.
 *
 * There is no terminal to dispose and no record to remove, so this is a signal
 * to a pid. What makes that safe is the re-read: this message names a process,
 * and the press came back through the webview, so every narrowing the view
 * applied is asked again here against a fresh reading and a fresh table. Any
 * miss signals nothing and redraws.
 *
 * `closeTree` and no reap: SIGTERM with no escalation where the OS can ask, and
 * termination on Windows, where it cannot and the reader's press is the consent.
 * A server that sits through SIGTERM is a server still on the port, which is a
 * true chip.
 *
 * Nothing here is reported back. A refusal leaves the chip's `stopping` mark to
 * time out and the ✕ to come back.
 */
export async function killListener(
  panel: PanelActions,
  port: number,
  pid: number,
  startedAt: number,
  command: string
): Promise<void> {
  const heard = (await sockets()).get(port);
  const table = await scanProcesses(true);
  const target =
    port < EPHEMERAL_FLOOR
      ? stoppable(heard, { pid, startedAt, command }, panel.sessions, table)
      : undefined;
  if (!target || !closeTree(target.pid, snapshotTree(target.pid, table), table, target.startedAt)) {
    void panel.refresh();
    return;
  }
  // The socket outlives the signal by a beat, exactly as `reanswerRunPicker`
  // waits out. Bounded the same way: past the cap the answer goes out saying
  // what is true rather than what was hoped for.
  const until = Date.now() + PORT_RELEASE_MS;
  let released = await free(port);
  while (!released && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, PORT_POLL_MS));
    released = await free(port);
  }
  // The cached reading is what the next poll draws from, and it is up to seven
  // seconds from being refreshed — long enough for the chip to sit there having
  // apparently ignored the press. Only this pid is dropped, and by pid rather
  // than by port: one process can hold two (an inspector beside its server), and
  // both went with it. Every other repo's chips stand.
  //
  // **Only when the port actually came free.** A process that sat through
  // SIGTERM is a process still serving, and dropping it here would blank a live
  // chip for the seven seconds until the next reading put it straight back —
  // the panel saying the port is free of a port that is not.
  const cache = panel.listeners;
  if (released && cache) {
    cache.found = cache.found.filter((heard) => heard.pid !== pid);
  }
  void panel.refresh();
}
