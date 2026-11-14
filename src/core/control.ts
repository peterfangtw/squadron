/**
 * Ends a session.
 *
 * A signal rather than the terminal API: a pid is machine-global, so this
 * reaches sessions in other IDE windows, which `terminal.dispose()` cannot. The
 * CLI installs a SIGTERM handler and shuts down cleanly.
 *
 * It used to signal the hosting shell as well, which is how a session someone
 * typed `claude` for was stopped. There is no such session on the board any
 * more (row 53), and every one that is left runs on a pipe with no shell of its
 * own — walking to one would climb through another window's extension host. The
 * measurements that path was built on are kept in
 * `docs/reference/process_signals.md`.
 *
 * Deliberately free of `vscode` imports so it stays testable headlessly.
 */

import { ProcessTable, descendants, scanProcesses } from './scan';
import { sameSessionStart } from './model';
import * as platform from './platform';
import type { Member, Outcome, Processes } from './platform/processes';
import type { Unsupported } from './platform/unsupported';

/** How one session fared at `endBySignal`; `Unsupported` when this OS has no
 *  guarded signal, said for every target before anything is scanned. */
export type SignalEnd = 'ended' | 'gone' | 'failed' | Unsupported;

/** The reap's SIGKILL timer; disposing it before it fires cancels the kill. */
export type Reap = { dispose(): void };

/**
 * Whoever keeps the reap: it holds the reap so its own disposal cancels it,
 * and is told when the reap has finished so it stops holding it — ending is something a
 * reader can do all day, and an entry per end would keep every swept subtree
 * for as long as the owner lived.
 */
export type ReapOwner = { hold(reap: Reap): void; release(reap: Reap): void };

/**
 * A `ReapOwner` that can be disposed while an end is still in flight: the
 * Remote host disposes its reaps before its engine drains, and an End waiting
 * on another window's close arms its reap after that. Once disposed, a reap
 * handed to it is cancelled at once rather than held by an owner that has gone.
 */
export class Reaps implements ReapOwner {
  private readonly held = new Set<Reap>();
  private disposed = false;

  /** How many are held, which a disposed owner keeps at none. */
  get size(): number {
    return this.held.size;
  }

  hold(reap: Reap): void {
    if (this.disposed) reap.dispose();
    else this.held.add(reap);
  }

  release(reap: Reap): void {
    this.held.delete(reap);
  }

  dispose(): void {
    this.disposed = true;
    for (const reap of this.held) reap.dispose();
    this.held.clear();
  }
}

/**
 * Ends by signal the sessions no pipe could close — the window holding one
 * refused, never answered, or is gone — and arms one reap for all of them.
 *
 * One fresh scan is both the list that gets signalled and the table its start
 * times are checked against, so it is taken here, after whatever the caller
 * waited on, and never reused from a display. A session whose start time no
 * longer matches is `gone` and nothing is sent: its number may already belong
 * to another program. One reap covers the whole list because it forks a `ps`
 * when it fires, and a timer per member would fork one each in the same tick.
 */
export async function endBySignal(
  targets: readonly { pid: number; startedAt: number }[],
  owner: ReapOwner,
  processes: Processes = platform.processes
): Promise<SignalEnd[]> {
  const { signals } = processes;
  if (!signals.supported) return targets.map(() => signals);
  const table = await scanProcesses(true);
  if (!table.complete) return targets.map(() => 'failed');
  const swept: TreeMember[] = [];
  const outcomes = targets.map(({ pid, startedAt }): SignalEnd => {
    try {
      if (!sameSessionStart(table.starts.get(pid), startedAt)) return 'gone';
      const tree = snapshotTree(pid, table);
      swept.push(...tree);
      return closeTree(pid, tree, table, startedAt, processes) ? 'ended' : 'failed';
    } catch {
      return 'failed';
    }
  });
  armReap(swept, owner, processes);
  return outcomes;
}

/**
 * SIGKILL for whatever outlived the sweep's SIGTERM, `REAP_GRACE_MS` later.
 *
 * Handed to an owner rather than left a bare `setTimeout`: an owner disposed
 * inside the grace — a panel closed, a host going down — must not have a kill
 * sent on its behalf after it is gone.
 *
 * The owner holds it until its read has settled, not only until the timer
 * fires: a cold native read takes seconds, and an owner disposed during it
 * must still send nothing. The flag is checked right before the signal.
 *
 * The fresh table is not required to be complete: each member is still judged
 * by its own row and exact start, so an unreadable row elsewhere costs no kill.
 */
function armReap(members: readonly TreeMember[], owner: ReapOwner, processes: Processes): void {
  if (!members.length) {
    return;
  }
  let cancelled = false;
  const entry: Reap = {
    dispose: () => {
      cancelled = true;
      clearTimeout(timer);
    }
  };
  const timer = setTimeout(() => {
    void scanProcesses(true)
      .then((fresh) => {
        if (!cancelled) processes.signal(members, 'kill', fresh);
      })
      .catch(() => undefined)
      .finally(() => owner.release(entry));
  }, REAP_GRACE_MS);
  owner.hold(entry);
}

/** One process a session started, as much of it as outlives the session. */
export type TreeMember = Member;

/** Retained exact ancestry orders descendants first, with the root always last. */
export function orderLifetimeMembers(
  root: number | undefined,
  members: readonly TreeMember[],
  table: ProcessTable
): TreeMember[] {
  const retained = new Map(members.map((member) => [member.pid, member]));
  const depth = (member: TreeMember): number => {
    if (member.pid === root) return -1;
    let found = 0;
    const seen = new Set([member.pid]);
    for (let parent = table.parents.get(member.pid); parent !== undefined && !seen.has(parent);) {
      const known = retained.get(parent);
      if (!known || table.starts.get(parent) !== known.startedAt) break;
      seen.add(parent);
      found++;
      parent = table.parents.get(parent);
    }
    return found;
  };
  return members
    .map((member, at) => ({ member, at, depth: depth(member) }))
    .sort((a, b) => b.depth - a.depth || a.at - b.at)
    .map(({ member }) => member);
}

/**
 * What `pid` has running below it, taken **while it is still alive**.
 *
 * The order this is called in is the whole design. A dead process's children
 * reparent to pid 1 and the table forgets the family, so a caller that ends a
 * session and then asks what it started gets an empty list every time. Take the
 * snapshot first, end the session, sweep the snapshot.
 */
export function snapshotTree(pid: number, table: ProcessTable): TreeMember[] {
  return descendants(pid, table.parents).map((child) => snapshotMember(child, table));
}

export function snapshotMember(pid: number, table: ProcessTable): TreeMember {
  const pgid = table.groups.get(pid);
  return { pid, ...(pgid === undefined ? {} : { pgid }), startedAt: table.starts.get(pid) ?? 0 };
}

/**
 * Ends a session and everything it started.
 *
 * The subtree goes first and the session last, deepest member first, so nothing
 * is asked to tear down while its own child is still being signalled. Each
 * member leading its own group is signalled by group (`platform.processes`
 * says why); the session itself is always signalled alone. A session the table
 * no longer shows is not signalled, and reads as stopped.
 */
export function closeTree(
  pid: number,
  members: readonly TreeMember[],
  table: ProcessTable,
  startedAt?: number,
  processes: Processes = platform.processes
): boolean {
  if (startedAt !== undefined && !sameSessionStart(table.starts.get(pid), startedAt)) return false;
  stop(members, table, processes);
  // The table's own start, so the backend's check stays exact; the caller's
  // stamp is a spawn-time clock, matched within `sameSessionStart`'s window.
  const own = table.starts.get(pid);
  if (own === undefined) return true;
  const [root] = stop([{ pid, startedAt: own }], table, processes, { alone: true });
  return root === 'sent' || root === 'absent';
}

/**
 * `stop`, or `kill` at once for each member this OS cannot ask to finish.
 * Windows has no such request (`platform/processes` `Intent`), and this End is
 * for a session no pipe could close, so ending it is the only thing left to do.
 */
function stop(
  members: readonly TreeMember[],
  table: ProcessTable,
  processes: Processes,
  options?: { alone?: boolean }
): Outcome[] {
  const outcomes = processes.signal(members, 'stop', table, options);
  const unasked = members.filter((_, at) => typeof outcomes[at] === 'object');
  if (!unasked.length) return outcomes;
  const killed = processes.signal(unasked, 'kill', table, options);
  let next = 0;
  return outcomes.map((outcome) =>
    typeof outcome === 'object' ? (killed[next++] ?? outcome) : outcome
  );
}

/**
 * How long the subtree gets between its SIGTERM and a SIGKILL it cannot decline.
 *
 * Shorter than the host's `STDIN_GRACE_MS`, and a different question: that one
 * asks a CLI to shut a session down, this one asks an `npm` or a `node` to
 * notice a signal at all. Anything that means to handle SIGTERM has done it well
 * inside this; anything that has not is not going to — no amount of waiting was
 * going to change the mind of a process blocked in a write for sixteen hours.
 *
 * The reap itself is the same members, `kill` rather than `stop`: a signal the
 * process does not get a say in. The orphan this exists for ignored SIGTERM for
 * sixteen hours with its main thread parked in a write, and a blocked process
 * never runs a handler.
 */
export const REAP_GRACE_MS = 2000;
