/**
 * Who is listening on a port, asked of the kernel rather than of our own
 * registry.
 *
 * `ports.ts` answers whether a port is *taken*; this answers *by what*. The
 * difference is the whole reason this file exists: a machine that slept through
 * its heartbeat loses every record in `servers.ts` to the staleness sweep, and
 * the panel is then left knowing 3000 is bound and nothing more — no branch, no
 * stop button, for a server it started itself. The listener is still there, and
 * the kernel never forgot which process it belongs to.
 *
 * Two readings per call. Measured 2026-08-05 on a ten-port block with three live
 * Vite servers on it, and 2026-08-07 across the whole machine (16 listening
 * pids):
 *
 * ```
 * lsof -nP +c 0 -iTCP:3000-3009 -sTCP:LISTEN -Fpcn   ->  47ms   port -> pid
 * lsof -a -p 42972,12470,13077 -d cwd -Fpn           ->  25ms   pid  -> cwd
 *
 * lsof -nP +c 0 -iTCP -sTCP:LISTEN -Fpcn             ->  34ms   112 lines
 * lsof -a -p <the 16> -d cwd -Fpn                    ->  12ms
 * ```
 *
 * The machine-wide reading was the cheaper one. The second reading is per
 * *pid*, so it scales with how many things listen, and a ranged first reading
 * paid for a filter the board does not use. A board holding four worktrees of
 * one repo would otherwise cost four spawn pairs to learn less.
 *
 * The `cwd` came back as `/Users/…/acme-web/apps/web`, which is
 * `RunningServer.cwd` verbatim, and is how a swept record of ours is recognised.
 * It exists on macOS only. The servers line needs none of it: `sockets` is the
 * first reading alone, and `sessionListeners` proves a listener is a session's
 * from the process table, on either OS.
 *
 * **Nothing here is cached, and nothing here is paced** — the caller decides how
 * often it wants to pay. `runs.ts` reads sockets off the poll's critical path,
 * and the card poll reads `processCwds` behind a last-good map so a wedged spawn
 * cannot hold the board (`host/panel.ts`).
 *
 * The **server picker does not use this file at all**, and that is deliberate
 * rather than an omission — a bind test says whether a port is *takeable*, which
 * is the picker's question, and `lsof` says who is *there*, which is the line's.
 */

import { type Session, sameSessionStart } from '../model';
import * as platform from '../platform';
import type { Socket } from '../platform/listeners';
import { type ProcessTable, descendants } from '../scan';

/** One listening socket, as the OS describes its owner. */
export type Listener = Socket & {
  /**
   * The listener's working directory, absent when the second reading failed or
   * was cut short. An unattributed listener is a true answer, not a broken one.
   */
  cwd?: string;
};

/** Empty/unavailable/failed cwd reads retain the domain's no-attribution answer. */
export async function processCwds(pids: readonly number[]): Promise<Map<number, string>> {
  const reading = await platform.listeners.cwds(pids);
  return reading.supported && reading.status === 'ok' ? reading.value : new Map();
}

/**
 * Every listener on the machine, by port.
 *
 * Keyed by port because that is what every caller has in hand — a registry
 * record's `port`. The board holds several repos at once, and a listener
 * outside any one of them is still a listener it can attribute.
 *
 * **One port keeps one listener, and a second pid on it is dropped.** Usually
 * they are the same process twice, a server binding both families. But a child
 * that inherited a listening fd is a *different* process on the same port, and
 * this reports only the one `lsof` printed first. Both walk to the same shell,
 * so ancestry attribution is unaffected; a caller that needs every holder of a
 * port needs a different shape than this map.
 *
 * **A port held by another user is invisible here, not unattributed:** an
 * unprivileged `lsof` cannot read another user's descriptors, so such a listener
 * produces no entry at all. `free()` still reports the port as taken, which is
 * what a picker draws.
 *
 * An empty map is the honest answer to a machine with nothing listening, no
 * `lsof`, and a reading that failed — no caller may read it as "nothing is
 * bound", which is `free()`'s question and is asked of the socket layer instead.
 */
export async function listeners(): Promise<Map<number, Listener>> {
  const byPort: Map<number, Listener> = await sockets();
  if (byPort.size === 0) {
    return byPort;
  }

  // One spawn for every pid rather than one each: `-p` takes a list. The
  // machine-wide reading does not bound that list, which is why the second
  // reading is measured per pid (12ms for 16 of them) rather than assumed small.
  const pids = [...new Set([...byPort.values()].map((listener) => listener.pid))];
  const dirs = await processCwds(pids);
  for (const [port, listener] of byPort) {
    const cwd = dirs.get(listener.pid);
    if (cwd !== undefined) {
      byPort.set(port, { ...listener, cwd });
    }
  }
  return byPort;
}

/** The first half of `listeners`, for a caller with no use for a directory. */
export async function sockets(): Promise<Map<number, Socket>> {
  const reading = await platform.listeners.read();
  if (!reading.supported || reading.status !== 'ok') return new Map();
  const byPort = new Map<number, Socket>();
  for (const listener of reading.value) {
    // First writer wins, so the map does not flip between polls when a process
    // binds two families and `lsof` orders them differently.
    if (!byPort.has(listener.port)) {
      byPort.set(listener.port, listener);
    }
  }
  return byPort;
}

/**
 * A socket and the native start of the process that held it, stamped once when
 * the reading lands. A socket names a pid and nothing else, so a later table
 * would otherwise lend it the identity of whatever took that number next.
 */
export type PinnedSocket = Socket & { startedAt: number };

export function pinned(found: Iterable<Socket>, table: ProcessTable): PinnedSocket[] {
  return [...found].flatMap((socket) => {
    const startedAt = table.starts.get(socket.pid);
    return startedAt === undefined ? [] : [{ ...socket, startedAt }];
  });
}

/** A listener an owned session is running, placed in that session's directory. */
export type SessionListener = PinnedSocket & { cwd: string; session: string };

type SessionFacts = Pick<Session, 'pid' | 'startedAt' | 'cwd' | 'name' | 'source' | 'background'>;

/**
 * Which sockets belong to which owned session. The one test of a server being
 * ours: running below that session's process now, on a complete table.
 *
 * The root's start goes through `sameSessionStart`, since `Session.startedAt` is
 * stamped at spawn and the table's is native; the socket's is exact, both being
 * native. The root itself is never a match: a CLI's own port is not a dev server.
 */
export function sessionListeners(
  found: readonly PinnedSocket[],
  sessions: readonly SessionFacts[],
  table: ProcessTable
): SessionListener[] {
  if (!table.complete) return [];
  const owner = new Map<number, SessionFacts>();
  for (const session of sessions) {
    if (session.source !== 'owned' || session.background) continue;
    if (!sameSessionStart(table.starts.get(session.pid), session.startedAt)) continue;
    for (const pid of descendants(session.pid, table.parents)) owner.set(pid, session);
  }
  return found.flatMap((socket) => {
    const session = owner.get(socket.pid);
    if (!session || table.starts.get(socket.pid) !== socket.startedAt) return [];
    return [{ ...socket, cwd: session.cwd, session: session.name }];
  });
}

/**
 * The session server a press may stop, or nothing. `want` crossed the webview,
 * so a field it lacks is a refusal, and only a listener that passes the whole
 * ownership join on this fresh table comes back.
 */
export function stoppable(
  heard: Socket | undefined,
  want: { pid: number; startedAt: number; command: string },
  sessions: readonly SessionFacts[],
  table: ProcessTable
): SessionListener | undefined {
  if (heard === undefined || aim(heard, want) !== 'same') return undefined;
  const target = sessionListeners(pinned([heard], table), sessions, table).at(0);
  return target?.startedAt === want.startedAt ? target : undefined;
}

/**
 * Whether the listener on a port now is the one a stop was aimed at.
 *
 * The chip a reader presses ✕ on was drawn from a reading up to `LISTENERS_MS`
 * plus a poll old, and a pid is a number the kernel hands back out. So the port
 * is read again at the press and the answer compared against what was drawn:
 * signalling on the first reading alone would signal whatever inherited the
 * number, which for a dev port is most likely the next dev server started.
 *
 * This compares pid and command only. A `node` that took a dead `node`'s number
 * back passes here, so `stoppable` also compares native starts.
 *
 * `changed` and `gone` are separate for the caller's sake, not this function's:
 * one means the port moved on and the other means it is already free, and a
 * caller that redraws would do the same for both. Neither may be signalled.
 */
export type Aim = 'same' | 'gone' | 'changed';

export function aim(heard: Listener | undefined, want: { pid: number; command: string }): Aim {
  if (heard === undefined) {
    return 'gone';
  }
  if (heard.pid !== want.pid) {
    return 'changed';
  }
  // An empty `command` on either side is a reading that had none, not a
  // mismatch — `parseListeners` omits the field when `lsof` printed no `c` line,
  // and refusing on that would make the ✕ do nothing on a machine where the
  // second half of the reading is thin.
  return want.command === '' || heard.command === undefined || heard.command === want.command
    ? 'same'
    : 'changed';
}
