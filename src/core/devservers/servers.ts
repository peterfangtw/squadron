/**
 * Which dev servers are running, and where. This says what is **alive**,
 * `ports.ts` says what a branch **used last**. They are separate because their
 * lifetimes are: a server dies with the window that holds its terminal, and a
 * remembered port survives a reboot.
 *
 * One file per server: read-and-sweep as in `claims.ts`, write as in
 * `files.ts`. A stale entry is removed as it is read, because nothing else
 * sweeps here and a leftover would hold a port in the picker forever.
 */

import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import * as path from 'path';
import { readJson, readJsonDir, writeAtomicJson } from '../files';
import { RunningServer } from '../model';
import { SERVERS_DIR } from '../paths';
import * as platform from '../platform';

/**
 * How long an entry outlives its last write. The owning window re-writes it on
 * the panel's poll. As with `CLAIM_STALE_MS`: long enough that a busy machine's
 * missed poll costs nothing, short enough that a crashed window's port comes
 * back. Its own constant, because the two are free to move apart.
 */
export const SERVER_STALE_MS = 90_000;

/**
 * How long a reservation is honoured before its window must hold a terminal.
 * Not a liveness horizon — that is `SERVER_STALE_MS`.
 */
export const SERVER_SETTLE_MS = 5_000;

/** Hashed like every other per-path record here; the `cwd` in the file says which. */
function fileFor(cwd: string, runnerId: string): string {
  const key = createHash('sha256').update(platform.paths.key(cwd)).digest('hex').slice(0, 16);
  // The runner id is an npm script name or a settings key, so it stays readable
  // and loses only what a filename cannot hold.
  return path.join(SERVERS_DIR, `${key}.${runnerId.replace(/[^\w.-]/g, '_')}.json`);
}

/** Records one server. Best effort, like every other store under `STATE_DIR`. */
export async function writeServer(server: RunningServer): Promise<void> {
  await writeAtomicJson(fileFor(server.cwd, server.runnerId), {
    ...server,
    updatedAt: Date.now()
  });
}

/**
 * Bumps one entry's `updatedAt` and touches nothing else.
 *
 * **The heartbeat may not carry a payload it merely remembers.** Three writers
 * own this file: the poll (the owning window is still here), the readiness
 * probe (the server answered) and the liveness probe (`judgeServer`, it stopped
 * answering). A poll that writes back the record it read a moment ago puts
 * `starting` over an `up` that landed in between. The probe has already
 * returned, so nothing retries it and the row stays amber for a server that is
 * serving. Re-reading inside the write keeps the poll to the one thing it knows.
 *
 * The liveness probe carries a payload it just observed, not one it echoes. It
 * goes through `reviseServer`, which refuses a record that stopped being ours
 * mid-probe.
 */
export async function touchServer(cwd: string, runnerId: string): Promise<void> {
  const file = fileFor(cwd, runnerId);
  const current = await readJson<RunningServer>(file);
  if (isServer(current)) {
    await writeAtomicJson(file, { ...current, updatedAt: Date.now() });
  }
}

/**
 * `touchServer`, for a caller that can still say what the record was.
 *
 * `touchServer` no-ops on a missing file. That is right for a server that
 * stopped and wrong for one whose record was swept while it kept serving: a
 * host frozen past `SERVER_STALE_MS` (a laptop that slept) comes back holding a
 * terminal that nothing on disk names.
 *
 * The caller's copy is a fallback, never an overwrite. What is on disk wins
 * whenever there is anything there, for the reason `touchServer` gives.
 */
export async function keepServer(
  server: RunningServer,
  stillHeld: () => boolean = () => true
): Promise<void> {
  const file = fileFor(server.cwd, server.runnerId);
  const current = await readJson<RunningServer>(file);
  // **Asked after the read, and that placement is the whole guard.** This
  // writes where `touchServer` only bumps, so a stop landing during the read
  // would be undone. The record put back says `up` for a gone terminal for
  // `SERVER_STALE_MS`, in the panel-hidden case where nothing else sweeps.
  // Asking before the read protects nothing: the caller's check and this one
  // would run in the same synchronous turn, so they cannot disagree.
  if (!stillHeld()) {
    return;
  }
  if (isServer(current)) {
    // **Only ever our own.** A record is one file per `cwd` and `runnerId`, not
    // per window, so two windows told to start the same thing share it and the
    // later write wins. Beating a record that names another window makes it
    // immortal: its own window can die and no window can correct it, because
    // the branch below refuses to write a payload over a file that exists.
    if (current.windowId === server.windowId) {
      await writeAtomicJson(file, { ...current, updatedAt: Date.now() });
    }
    return;
  }
  await writeAtomicJson(file, { ...server, updatedAt: Date.now() });
}

/** Forgets one, on stop or on a window closing. A file that is not there is a stop. */
export async function removeServer(cwd: string, runnerId: string): Promise<void> {
  await fs.rm(fileFor(cwd, runnerId), { force: true }).catch(() => {});
}

/**
 * Every live server on the machine. Stale and malformed files are removed as
 * they are read: a record neither swept nor rejected is immortal (`readClaims`).
 */
export async function readServers(): Promise<RunningServer[]> {
  const gone: string[] = [];
  const servers = await readJsonDir(SERVERS_DIR, (raw, name) => {
    if (isServer(raw) && Date.now() - raw.updatedAt <= SERVER_STALE_MS) {
      // Only the file today's key names: one hashed from an older key (a win32
      // lower-drive spelling) would be a second record of this server, which
      // no write or remove reaches. It goes when it goes stale.
      return name === path.basename(fileFor(raw.cwd, raw.runnerId)) ? raw : undefined;
    }
    gone.push(name);
    return undefined;
  });
  await Promise.all(
    gone.map((name) => fs.rm(path.join(SERVERS_DIR, name), { force: true }).catch(() => {}))
  );
  return servers;
}

/**
 * This window's dead records versus the ones still live.
 *
 * A record of ours whose terminal is gone is removed now, not at staleness:
 * this window knows the answer. Foreign records stay, because another window
 * owns them. Ours and unheld for less than `SERVER_SETTLE_MS` also stay: the
 * reservation is written first (`docs/PRD/PRD_shipped_dev_servers.md`), and a
 * poll landing in that gap must not sweep the file it just read.
 */
/**
 * The reason a start refused at the press carries: its port was bound or
 * reserved before anything was spawned (`runServerHere`). Nothing was started,
 * so no terminal holds the record; `reconcileServers` keeps it and
 * `drawnHere` draws it anyway — `SERVER_STALE_MS` on read, or the row's Stop,
 * is what takes it away.
 */
export const IN_USE = 'port in use';

const refusedAtPress = (server: RunningServer): boolean =>
  server.status === 'failed' && server.reason === IN_USE;

/**
 * Whether this window's board draws a record: it holds the terminal, or it
 * refused the start at the press. Another window's record would claim a
 * terminal this one cannot dispose.
 */
export function drawnHere(
  server: RunningServer,
  opts: { windowId: string; holds: (cwd: string, runnerId: string) => boolean }
): boolean {
  return (
    opts.holds(server.cwd, server.runnerId) ||
    (server.windowId === opts.windowId && refusedAtPress(server))
  );
}

export function reconcileServers(
  running: readonly RunningServer[],
  opts: {
    windowId: string;
    holds: (cwd: string, runnerId: string) => boolean;
    now: number;
  }
): { remove: RunningServer[]; keep: RunningServer[] } {
  const held = (server: RunningServer) =>
    opts.holds(server.cwd, server.runnerId) ||
    opts.now - server.startedAt < SERVER_SETTLE_MS ||
    refusedAtPress(server);
  return {
    remove: running.filter((server) => server.windowId === opts.windowId && !held(server)),
    keep: running.filter((server) => server.windowId !== opts.windowId || held(server))
  };
}

/**
 * How many consecutive silent probes call a held server dead.
 *
 * One would do if a silent port were only ever a dead one. It is not: a
 * toolchain that restarts its listener on a config change (nodemon, a Vite full
 * reload) closes the socket and re-opens it, and a probe landing in that gap
 * gets the same `ECONNREFUSED` a corpse gives. Not measured against any of them.
 * Two is the cheap margin over a real case, not a timed one, and at the
 * heartbeat's rate it still lands inside a minute.
 *
 * `PROBE_TIMEOUT_MS` (500ms) stops a *slow* answer counting as silence. It does
 * nothing about a listener that is gone for a moment.
 */
export const DEAD_AFTER_MISSES = 2;

/**
 * The word a record dead by observation carries. It tells this verdict from
 * `awaitReady`'s `port taken`, and the two are revisited differently below.
 */
const STOPPED = 'stopped';

/**
 * Whether the heartbeat has standing to ask this record's port.
 *
 * **Holding a terminal is not being alive.** A shell outlives the command it
 * ran, so `npm` exiting inside a live tab closes nothing the host is told about:
 * `holdsServer` stays true, the heartbeat goes on writing `up`, and the chip is
 * green for a dead server. Ownership is the terminal's to say. Liveness is
 * asked of the port.
 *
 * Two alternatives were left. Asking whether the shell parents anything is
 * confounded by a shell between commands. `onDidEndTerminalShellExecution`
 * (stock from 1.93) does not see a `sendText` issued before shell integration
 * activates, which is every start `startServer` makes. Either is a measurement
 * away from being the better answer.
 *
 * Exclusions, each a record the heartbeat has no business judging:
 *
 * - `starting` belongs to `awaitReady` (`host/runs.ts`) for the twenty seconds
 *   after a spawn. A probe here would race it and call a booting server dead.
 * - A portless runner (the extension dev host) has no socket to ask. Nothing
 *   here observes whether the window it opens is still open.
 * - `failed` is asked **only when this rule failed it.** A `stopped` verdict
 *   deliberately leaves the terminal open, so the reader often fixes the build
 *   and re-runs in that tab. A verdict nothing revisits would then say
 *   *Run · stopped* over a live server, with the Run disposing the tab they were
 *   reading. `port taken` stays one-shot: that record never saw its port
 *   answer, so a later listener on it is more likely somebody else's than ours.
 */
export function probeable(server: RunningServer): server is RunningServer & { port: number } {
  if (server.port === undefined) {
    return false;
  }
  return server.status === 'up' || (server.status === 'failed' && server.reason === STOPPED);
}

/**
 * What one probe does to a record: the strike count it leaves, and the record to
 * write in its place if the verdict changed. `next` absent is the ordinary
 * answer: a server that answered and was already `up`, or one whose silence has
 * not yet reached `DEAD_AFTER_MISSES`. The caller heartbeats those and writes
 * nothing.
 *
 * Strikes are consecutive, so an answer clears the count: what matters is a
 * server that has stopped, not one that was busy twice in an afternoon.
 */
export function judgeServer(
  server: RunningServer,
  answered: boolean,
  misses: number
): { misses: number; next?: RunningServer } {
  if (answered) {
    if (server.status === 'up') {
      return { misses: 0 };
    }
    // Back from the dead: same terminal, same port, answering again. The reason
    // goes with the status, because the chip prints it and `stopped` over a
    // green dot contradicts the row.
    const revived: RunningServer = { ...server, status: 'up' };
    delete revived.reason;
    return { misses: 0, next: revived };
  }
  // Already dead and still silent: no second verdict to reach, so nothing to
  // write and no count to keep.
  if (server.status !== 'up') {
    return { misses: 0 };
  }
  const struck = misses + 1;
  return struck >= DEAD_AFTER_MISSES
    ? { misses: struck, next: { ...server, status: 'failed', reason: STOPPED } }
    : { misses: struck };
}

/**
 * Writes a record over the one on disk, and **only where that record is still
 * ours to revise.** `writeServer`'s guarded sibling, for the heartbeat.
 *
 * Two refusals. A file naming another window is `keepServer`'s rule, and two
 * windows holding a terminal for one `(cwd, runnerId)` on different ports
 * reach it. A file that is *gone* was removed by a stop landing mid-probe.
 * Putting a payload back would resurrect a record nothing holds and no window
 * will correct, until the staleness sweep.
 *
 * `keepServer` writes its caller's copy back because the record was swept. A
 * liveness verdict does not: no record is no chip, which is the right answer
 * for a server that is not there.
 *
 * Reports whether it wrote, so the caller can keep its own memory in step.
 */
export async function reviseServer(server: RunningServer): Promise<boolean> {
  const file = fileFor(server.cwd, server.runnerId);
  const current = await readJson<RunningServer>(file);
  if (!isServer(current) || current.windowId !== server.windowId) {
    return false;
  }
  await writeAtomicJson(file, { ...server, updatedAt: Date.now() });
  return true;
}

const STATUSES: RunningServer['status'][] = ['starting', 'up', 'failed'];

/** Narrowed field by field — `updatedAt` above all, which is what sweeps it. */
function isServer(value: unknown): value is RunningServer {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const server = value as Partial<RunningServer>;
  return (
    typeof server.cwd === 'string' &&
    typeof server.runnerId === 'string' &&
    typeof server.label === 'string' &&
    typeof server.windowId === 'string' &&
    STATUSES.includes(server.status as RunningServer['status']) &&
    typeof server.updatedAt === 'number' &&
    Number.isFinite(server.updatedAt)
  );
}
