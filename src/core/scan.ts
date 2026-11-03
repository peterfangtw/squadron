import * as platform from './platform';
import type * as processes from './platform/processes';
import type { BrandId } from './brands';

export type Proc = { pid: number; ppid: number; command: string | null; startedAt: number };

/** Background plumbing the CLI spawns for itself — not user sessions. */
const INTERNAL = /^(daemon|bg-pty-host|bg-spare|--bg-pty-host|--bg-spare)$/;

/**
 * What a row runs, as far as its spelling says: the program's file name and
 * its first argument, `undefined` when the arguments are unknown.
 */
type Named = { name: string; first: string | undefined };

/** Exported for its test: the internal names are observed CLI facts. */
export function isClaudeProcess(command: string): boolean {
  return isClaude(posixNamed(command));
}

/** A Claude whose arguments are unknown could be its plumbing, so is not one. */
function isClaude({ name, first }: Named): boolean {
  return name === 'claude' && first !== undefined && !INTERNAL.test(first);
}

/**
 * Any Grok process, TUI or ACP, whatever its subcommand.
 *
 * Basename `grok` or the versioned download name `grok-1.0.*` (`lsof` comm
 * on 1.0.4). Kept whole on purpose: `grok/auth.ts` refuses a token refresh
 * while any grok runs, and a typed `grok` spends the same refresh token.
 * Discovery narrows to published pids itself (`grok/discover.ts`). Grok's
 * Windows background updater (`grok.exe update --trigger=auto_background`, or
 * `grok-1.0.70-windows-x86_64.exe` with no command line, 2026-10-26) is one
 * too: no window publishes it, so it is never a session, and it is not a
 * shell, so it never runs a command.
 */
export function isGrokProcess(command: string): boolean {
  return isGrok(posixNamed(command));
}

function isGrok({ name }: Named): boolean {
  return name === 'grok' || /^grok-1\.\d/.test(name);
}

/** The shells the CLI spawns a command under. Exported for its test, like
 *  `isClaudeProcess`: these names are an observed fact, not a standard. */
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);

/**
 * The tool shells observed on Windows, 2026-10-26: Claude's Git `bin\bash.exe`
 * launcher and MSYS `usr\bin\bash.exe` below it; Grok's bare `"powershell.exe"`
 * and Codex's absolute Windows PowerShell, each `-Command`. `conhost.exe`, the
 * console every one of these processes gets, is never a shell: it runs no
 * command. `pwsh`, `cmd` and `sh` were not seen running a tool call.
 */
const WINDOWS_SHELLS = new Set(['bash', 'powershell']);

/**
 * A shell the CLI started to run something — `/bin/zsh -c …`, for a tool call
 * or for a task the user sent to the background. The interactive shell a
 * terminal opens with is never one of these: it is the CLI's *parent*, and
 * nothing here looks upward.
 */
export function isShellProcess(command: string): boolean {
  return SHELLS.has(posixNamed(command).name);
}

/** `ps` prints argv joined by spaces, so a path with a space is not told apart. */
function posixNamed(command: string): Named {
  const [argv0 = '', argv1 = ''] = command.split(/\s+/);
  return { name: argv0.split('/').pop() ?? '', first: argv1 };
}

/**
 * A Windows row, named by the image file WMI reports, else by the program
 * token the capability split off its command line. 2026-10-26: one
 * `claude.exe` was `C:/…/claude.exe -p`, `C:\…\claude.exe --print` and
 * `"C:/…/claude.exe"  -p` by launcher; its image one spelling. File names
 * compare without case or `.exe`, as Windows resolves them (`PING.EXE`). A
 * runtime wrapper (`node.exe -e …`) is its runtime, not the CLI it starts.
 */
function windowsNamed({ image, invocation }: processes.Row): Named {
  const file = image ?? invocation?.program ?? '';
  const name = (file.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  const first = invocation?.args.split(/\s+/)[0];
  return { name, first: first?.replace(/^"([^"\\]*)"$/, '$1') };
}

export type ProcessTable = {
  /** True only for a complete successful native scan. */
  complete?: boolean;
  startSource?: processes.StartSource;
  /**
   * Why this OS has no table at all, as distinct from a scan that failed:
   * the table is then empty and incomplete, and proves nothing, as a failed
   * one does. Kept for a caller that has to say why it cannot act.
   */
  unavailable?: string;
  /** User-facing claude processes, by pid. */
  claude: Map<number, Proc>;
  /** Grok processes, by pid — TUI and ACP alike. */
  grok: Map<number, Proc>;
  /** Codex processes, by pid — every one whose binary is `codex`. */
  codex: Map<number, Proc>;
  /** Every observed pid; undefined means its parent edge was refuted. */
  parents: Map<number, number | undefined>;
  /** pid -> start time for every process, for identifying a session's process. */
  starts: Map<number, number>;
  /**
   * pid -> process group, for signalling a subtree that ancestry has lost.
   *
   * A process group outlives the parent link: when a process dies its children
   * reparent to pid 1 and `parents` forgets they were ever a family, but their
   * pgid does not change. Observed 2026-08-01 — a grandchild reparented to
   * PPID 1 still carried its original group.
   *
   * The CLI leans on this without being asked to: it starts every tool call as
   * its own group **leader**, so `pgid === pid` marks a shell whose whole
   * subtree can be signalled by group. A session's own group is no use for the
   * same job — an owned session inherits the IDE's, which is why nothing here
   * may signal a group it has not first confirmed is led by the pid it means.
   */
  groups: Map<number, number>;
  /**
   * Pids running at least one shell of their own. A session in here is running
   * a command — the fact its status file only reports while it is otherwise
   * idle, and calls `shell`.
   */
  shellParents: Set<number>;
};

function empty(): ProcessTable {
  return {
    complete: false,
    claude: new Map(),
    grok: new Map(),
    codex: new Map(),
    parents: new Map(),
    starts: new Map(),
    groups: new Map(),
    shellParents: new Set()
  };
}

const EMPTY = empty();

/** What the root-to-CLI association reads of a table. */
export type Ancestry = Pick<
  ProcessTable,
  'parents' | 'starts' | 'shellParents' | 'claude' | 'grok' | 'codex'
>;

/**
 * The runtime root a recognized CLI was started under, when it was: npm's
 * Codex launcher is `node …/bin/codex.js`, and the native `codex` is its
 * child (observed 2026-10-27; Windows' `followShim` starts the same root).
 * The root is the pid we spawn and publish, so a session's identity stays the
 * root's; this only says which native process stands for it.
 *
 * One direct, unrefuted parent edge, to a parent that is not itself a
 * recognized CLI: a native codex's own `codex` helpers are not sessions under
 * a wrapper. A caller still has to prove the root is a session (its record).
 */
export function wrapperOf(table: Ancestry, native: Proc): number | undefined {
  const root = table.parents.get(native.pid);
  if (root === undefined || !table.starts.has(root) || isCli(table, root)) return undefined;
  return root;
}

/**
 * Whether the session at `root` is running a command: a shell of the root's
 * own, or of a `brand` CLI the root wraps (`wrapperOf`). Only one hop, and
 * only that brand, so an unrelated child's shell is never the session's.
 */
export function runsCommand(table: Ancestry, root: number, brand: BrandId): boolean {
  if (table.shellParents.has(root)) return true;
  if (isCli(table, root)) return false;
  return [...table[brand].values()].some(
    (proc) => table.parents.get(proc.pid) === root && table.shellParents.has(proc.pid)
  );
}

function isCli(table: Ancestry, pid: number): boolean {
  return table.claude.has(pid) || table.grok.has(pid) || table.codex.has(pid);
}

/**
 * Every process below `pid`, deepest first and excluding `pid` itself.
 *
 * A walk down `parents` to find what a session started. A tool call is a
 * subtree — `claude` -> `zsh -c` -> `npm` -> `node` —
 * and stopping a session that signals only its own pid leaves all of it running.
 *
 * **Only answerable while the parent lives.** A dead process's children reparent
 * to pid 1, and this map has no memory of who they used to belong to — so a
 * caller that means to signal a subtree must take its answer before ending the
 * session, not after. What survives that reparenting is the process group, which
 * is why `groups` is read beside this and not instead of it.
 *
 * Deepest first, which is a stable order to assert against rather than a rule
 * anything depends on — a caller sends its signals in one tick, so nothing is
 * scheduled between them either way. The visited set is for a malformed table
 * rather than a real machine: `ps` cannot report a cycle, but a walk that would
 * spin forever on one is not worth the bytes it saves.
 */
export function descendants(
  pid: number,
  parents: ReadonlyMap<number, number | undefined>
): number[] {
  const children = new Map<number, number[]>();
  for (const [child, parent] of parents) {
    if (parent !== undefined && child !== parent) {
      const kids = children.get(parent);
      if (kids) {
        kids.push(child);
      } else {
        children.set(parent, [child]);
      }
    }
  }

  const found: number[] = [];
  const seen = new Set<number>([pid]);
  // Breadth-first, so `found` comes out shallowest-first and is reversed once at
  // the end — cheaper than sorting by a depth nothing else needs.
  for (let frontier = [pid]; frontier.length;) {
    const next: number[] = [];
    for (const parent of frontier) {
      for (const child of children.get(parent) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          found.push(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return found.reverse();
}

/**
 * How long one pass is reused. `ps -A` costs ~25ms of fork, exec and parse
 * whatever the machine is doing, and the panel's file watchers can ask for a
 * refresh every 150ms while a session writes its status file — a burst that
 * would otherwise spend a sixth of a core on the same answer. Kept under the
 * 3s poll, so process death is still noticed within one poll.
 */
export const CACHE_MS = 1000;

/** Reads the process table with the shared cache in front of it. */
export type Scan = (fresh?: boolean) => Promise<ProcessTable>;

/**
 * The process table, at most `CACHE_MS` old. Concurrent callers share the scan
 * in flight rather than each spawning their own; the promise is cached, not its
 * result, so the second caller of a burst waits on the first instead of racing.
 *
 * Everything downstream — liveness, ancestry, start times — is derived from
 * this, so a refresh spawns one `ps`, not three.
 *
 * `fresh` skips the cache, for the callers that act on the answer rather than
 * displaying it: a stale table can only cost a display a beat, but it could
 * cost a signal the process it meant, or a refresh the proof no grok runs.
 */
export const scanProcesses: Scan = tableCache(() => platform.processes.snapshot());

/**
 * The one-second promise cache over any snapshot source, which is what
 * `scanProcesses` is over `platform.processes`. It knows nothing of how the
 * reader lives: a reusable reader's backoff, idle exit or disposal reaches it
 * only as an answer, and a failed answer is never kept.
 *
 * Aged on the monotonic clock, not the wall one: a backward step (NTP, a VM
 * resumed from a snapshot) would otherwise pin the cache for the size of the
 * step, and every reader would call dead sessions alive for that long.
 */
export function tableCache(
  snapshot: () => Promise<processes.Snapshot>,
  now: () => number = () => performance.now()
): Scan {
  let cached: { at: number; table: Promise<ProcessTable> } | undefined;
  return (fresh = false) => {
    const at = now();
    if (!fresh && cached && at - cached.at < CACHE_MS) {
      return cached.table;
    }

    const entry = { at, table: snapshot().then(tableOf) };
    cached = entry;
    // A failed or unsupported scan yields the empty table, which every reader treats as "nothing
    // is alive" — remembering that for a second would blank the whole panel and
    // silence the watcher's retry. So drop it the moment it lands, unless a newer
    // scan has already replaced it, and let the next caller spawn its own.
    void entry.table.then((table) => {
      if (table.parents.size === 0 && cached === entry) {
        cached = undefined;
      }
    });
    return entry.table;
  };
}

/**
 * Clocks whose starts order a parent before its child, so a parent younger
 * than its child is a recycled pid. An unrecognized clock refutes nothing.
 */
const ORDERED = new Set<processes.StartSource>(['ps-lstart-v1', 'win32-filetime-ms-v1']);

/**
 * One snapshot, classified once: the brand and shell readings are taken in the
 * pass that builds the maps, and the native rows are not kept beside them.
 * A Windows table's rows are named by Windows' rules, every other table's by
 * `ps`'s, so a Darwin row reads exactly as it did.
 */
export function tableOf(snapshot: processes.Snapshot): ProcessTable {
  if (!snapshot.supported) return { ...empty(), unavailable: snapshot.reason };
  if (snapshot.status === 'failed') return EMPTY;
  const table: ProcessTable = {
    complete: snapshot.status === 'ok',
    startSource: snapshot.value.source,
    claude: new Map(),
    grok: new Map(),
    codex: new Map(),
    parents: new Map(),
    starts: new Map(),
    groups: new Map(),
    shellParents: new Set()
  };
  const windows = snapshot.value.source === 'win32-filetime-ms-v1';
  const shells = windows ? WINDOWS_SHELLS : SHELLS;
  const rows = snapshot.value.rows.map((row) => ({
    row,
    named: windows ? windowsNamed(row) : posixNamed(row.command ?? '')
  }));
  for (const { row, named } of rows) {
    const { pid, ppid, pgid, startedAt, command } = row;
    table.starts.set(pid, startedAt);
    if (pgid !== undefined) table.groups.set(pid, pgid);
    if (isClaude(named)) {
      table.claude.set(pid, { pid, ppid, command, startedAt });
    }
    if (isGrok(named)) {
      table.grok.set(pid, { pid, ppid, command, startedAt });
    }
    // Any codex binary, whatever it is running: discovery keeps only the pids
    // some window published (`codex/discover.ts`), so no argv reading here
    // has anything left to decide.
    if (named.name === 'codex') {
      table.codex.set(pid, { pid, ppid, command, startedAt });
    }
  }
  for (const { row, named } of rows) {
    const { pid, ppid, startedAt } = row;
    const parentStart = table.starts.get(ppid);
    const refuted =
      table.startSource !== undefined &&
      ORDERED.has(table.startSource) &&
      parentStart !== undefined &&
      Number.isFinite(parentStart) &&
      Number.isFinite(startedAt) &&
      parentStart > startedAt;
    table.parents.set(pid, refuted ? undefined : ppid);
    if (!refuted && shells.has(named.name)) table.shellParents.add(ppid);
  }
  return table;
}
