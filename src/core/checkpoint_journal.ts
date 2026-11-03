import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileIdentity, readTree, treeAliases } from './git';
import { CHECKPOINTS_DIR } from './paths';
import * as platform from './platform';
import type { Written } from './transcript';
import * as checkpointModel from './checkpoint_model';

export type RuntimeNote =
  | string
  | { kind: 'capture'; tree: string; owner: string; runtime: string; actor: string; call: string }
  | { kind: 'runtime-end'; runtime: string; at: number }
  | { kind: 'task-end'; owner: string; runtime: string; actor: string; task: string; at: number };

export async function readRuntimeNotes(contextFile: string): Promise<RuntimeNote[] | undefined> {
  try {
    const notes: RuntimeNote[] = [];
    for (const line of (await fs.readFile(`${contextFile}.trees`, 'utf8')).split('\n')) {
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value === 'string' && path.isAbsolute(value)) {
          notes.push(value);
          continue;
        }
        const note = objectIn(value);
        if (!note || !identityIn(note.runtime)) continue;
        const at = typeof note.at === 'number' && Number.isFinite(note.at) ? note.at : undefined;
        if (note.kind === 'runtime-end' && at !== undefined) {
          notes.push({ kind: 'runtime-end', runtime: note.runtime, at });
        } else if (identityIn(note.owner) && identityIn(note.actor)) {
          if (note.kind === 'task-end' && identityIn(note.task) && at !== undefined)
            notes.push({
              kind: 'task-end',
              owner: note.owner,
              runtime: note.runtime,
              actor: note.actor,
              task: note.task,
              at
            });
          else if (
            (note.kind === undefined || note.kind === 'capture') &&
            typeof note.tree === 'string' &&
            path.isAbsolute(note.tree) &&
            identityIn(note.call)
          )
            notes.push({
              kind: 'capture',
              tree: note.tree,
              owner: note.owner,
              runtime: note.runtime,
              actor: note.actor,
              call: note.call
            });
        }
      } catch {
        /* A torn journal row proves neither a registration nor an ending. */
      }
    }
    return notes;
  } catch {
    return undefined;
  }
}

export async function appendExecution(
  treeRoot: string,
  evidence: checkpointModel.ExecutionEvidence
): Promise<boolean> {
  const normalized = executionEvidenceIn(evidence, treeRoot);
  if (!normalized) return false;
  try {
    const file = windowsFile(treeRoot);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(normalized)}\n`);
    return true;
  } catch {
    return false;
  }
}

export async function readExecution(
  treeRoot: string,
  aliases: readonly string[] = []
): Promise<checkpointModel.ExecutionStore> {
  const tree = await readTree(treeRoot);
  const canonical = tree?.treeRoot ?? treeRoot;
  const roots = [
    ...new Set([
      canonical,
      treeRoot,
      ...treeAliases(canonical),
      ...aliases.filter((root) => path.isAbsolute(root))
    ])
  ].sort();
  const files = new Set<string>();
  const sources = await Promise.all(
    roots
      .filter((root) => {
        const file = windowsFile(root);
        if (files.has(file)) return false;
        files.add(file);
        return true;
      })
      .map(readExecutionFile)
  );
  if (sources.length === 1) return sources[0] ?? EMPTY_STORE;
  const hit = aliasWindowCache.get(canonical);
  if (
    hit &&
    hit.sources.length === sources.length &&
    hit.sources.every((was, i) => was === sources[i])
  )
    return hit.store;
  const store = projectExecution({
    readable: sources.every((source) => source.readable),
    legacy: sources.flatMap((source) => source.legacy),
    edges: sources.flatMap((source) => source.edges),
    coverage: sources.flatMap((source) => source.coverage),
    active: sources.flatMap((source) => source.active),
    ended: sources.flatMap((source) => source.ended),
    callEnds: sources.flatMap((source) => source.callEnds)
  });
  aliasWindowCache.set(canonical, { sources, store });
  return store;
}

/**
 * Hash the full path because different repositories can share a tree basename.
 * Keep the tree name legible and the identity stable across restarts and windows.
 */
export function windowsFile(treeRoot: string): string {
  const resolved = path.resolve(treeRoot);
  const digest = createHash('sha1').update(platform.paths.key(resolved)).digest('hex').slice(0, 12);
  // Only what a filename may hold, and short: this is a label beside the digest,
  // never the identity.
  const label = path
    .basename(resolved)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 40);
  return path.join(CHECKPOINTS_DIR, `${label || 'tree'}-${digest}.jsonl`);
}

/**
 * Records what one turn did to one tree. Never throws — a store that failed to
 * write costs a neighbour's subtraction, which degrades to a turn drawing no
 * checkpoint pills, and must never reach the session.
 *
 * **Several windows write this file**, so the single-writer argument
 * `core/record.ts` rests on is not available. What replaces it is the write
 * itself: one short line, appended with `O_APPEND`, which the kernel makes
 * atomic — so interleaving produces whole lines in some order, never a torn one.
 * `readWindows` drops a torn last line anyway, for the crash case.
 */
export async function appendWindow(
  treeRoot: string,
  window: checkpointModel.TurnWindow
): Promise<void> {
  const file = windowsFile(treeRoot);
  const line = `${JSON.stringify(window)}\n`;
  try {
    await fs.appendFile(file, line);
  } catch {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, line);
    } catch {
      // The turn's own record still has its diff; only the neighbour index is
      // lost, and the gate degrades to drawing nothing for turns it overlaps.
    }
  }
}

/**
 * Every window recorded against this tree, oldest first, or an empty list.
 *
 * **Cached on `size:mtimeMs`, and the same array comes back for an unchanged
 * file** — the contract `readRecord` states, for the same caller and the same
 * reason: the dock re-reads this on every poll, and the merge downstream is
 * memoised on this array's identity to avoid rebuilding a thread that has not
 * changed.
 */
type ParsedExecutionStore = checkpointModel.ExecutionStore & {
  legacy: checkpointModel.TurnWindow[];
};

const windowCache = new Map<string, { stamp: string; store: ParsedExecutionStore }>();

const aliasWindowCache = new Map<
  string,
  { sources: readonly ParsedExecutionStore[]; store: ParsedExecutionStore }
>();

export async function readWindows(
  treeRoot: string,
  aliases: readonly string[] = []
): Promise<checkpointModel.TurnWindow[]> {
  return (await readExecution(treeRoot, aliases)).windows;
}

async function readExecutionFile(treeRoot: string): Promise<ParsedExecutionStore> {
  const file = windowsFile(treeRoot);
  let stamp: string;
  try {
    const { size, mtimeMs } = await fs.stat(file);
    stamp = `${size}:${mtimeMs}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? EMPTY_STORE : UNREADABLE_STORE;
  }
  const hit = windowCache.get(file);
  if (hit?.stamp === stamp) return hit.store;
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return UNREADABLE_STORE;
  }
  const legacy: checkpointModel.TurnWindow[] = [];
  const edges: checkpointModel.ExecutionBoundary[] = [];
  const coverage: checkpointModel.ExecutionCoverage[] = [];
  const active: checkpointModel.ExecutionActive[] = [];
  const ended: checkpointModel.ExecutionEnd[] = [];
  const callEnds: checkpointModel.ExecutionCallEnd[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const value = objectIn(parsed);
    if (!value) continue;
    if (value.version !== undefined || value.kind !== undefined) {
      // Skipped like a torn line: a newer build's row, or one bad write, must not
      // silence every turn on this tree for as long as the file lives.
      const evidence = executionEvidenceIn(parsed, treeRoot);
      if (!evidence) continue;
      switch (evidence.kind) {
        case 'execution':
          edges.push(evidence);
          break;
        case 'coverage':
          coverage.push(evidence);
          break;
        case 'active':
          active.push(evidence);
          break;
        case 'runtime-end':
          ended.push(evidence);
          break;
        case 'call-end':
          callEnds.push(evidence);
          break;
      }
      continue;
    }
    if (
      typeof value.sid !== 'string' ||
      !orderedTimes(value.start, value.end) ||
      !Array.isArray(value.paths)
    )
      continue;
    legacy.push({
      sid: value.sid,
      start: value.start as number,
      end: value.end as number,
      paths: value.paths.filter((at): at is string => typeof at === 'string')
    });
  }
  const store = projectExecution({
    readable: true,
    legacy,
    edges,
    coverage,
    active,
    ended,
    callEnds
  });
  windowCache.set(file, { stamp, store });
  return store;
}

function projectExecution(source: Omit<ParsedExecutionStore, 'windows'>): ParsedExecutionStore {
  if (!source.readable) return { ...source, windows: UNREADABLE_WINDOWS };
  const decisions = new Map<string, checkpointModel.ExecutionCoverage>();
  const conflicting = new Set<string>();
  for (const decision of source.coverage) {
    const key = JSON.stringify([decision.owner, decision.runtime, decision.turn]);
    const previous = decisions.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(decision)) conflicting.add(key);
    else decisions.set(key, decision);
  }
  // Indexed once: scanning coverage per legacy line and decisions per edge pair
  // took 5.1s a read at 2,000 turns of 10 calls, and the file re-parses on every append.
  const floors = new Set<string>();
  for (const decision of source.coverage)
    if (decision.floor)
      floors.add(
        JSON.stringify([
          decision.owner,
          decision.floor.from.startedAt ?? decision.floor.from.at,
          decision.floor.to.at
        ])
      );
  const windows = source.legacy.filter(
    (window) => !floors.has(JSON.stringify([window.sid, window.start, window.end]))
  );
  for (const [key, decision] of decisions) {
    if (conflicting.has(key) || decision.source === 'none') {
      windows.push({
        sid: decision.owner,
        start: decision.start,
        end: decision.end,
        paths: [],
        uncertain: true
      });
      continue;
    }
    for (const interval of decision.windows)
      windows.push({
        sid: decision.owner,
        start: interval.from.startedAt ?? interval.from.at,
        end: interval.to.at,
        paths: interval.changes.files
      });
  }
  const endedAt = new Map<string, number>();
  for (const end of source.ended)
    endedAt.set(end.runtime, Math.max(endedAt.get(end.runtime) ?? -Infinity, end.at));
  const runtimeEnd = (runtime: string): number => endedAt.get(runtime) ?? Infinity;
  const decided = new Map<string, checkpointModel.ExecutionCoverage>();
  for (const decision of decisions.values())
    for (const call of decision.calls) {
      const key = JSON.stringify([decision.owner, decision.runtime, call.actor, call.call]);
      if (!decided.has(key)) decided.set(key, decision);
    }
  const stops = new Map<string, number[]>();
  for (const stop of source.callEnds) {
    const key = checkpointModel.executionKey(stop);
    stops.set(key, [...(stops.get(key) ?? []), stop.at]);
  }
  for (const active of source.active) {
    if (decisions.has(JSON.stringify([active.owner, active.runtime, active.turn]))) continue;
    windows.push({
      sid: active.owner,
      start: active.start,
      end: runtimeEnd(active.runtime),
      paths: [],
      uncertain: true
    });
  }
  const paired = new Map<string, checkpointModel.ExecutionBoundary[]>();
  for (const edge of source.edges) {
    const key = checkpointModel.executionKey(edge);
    const list = paired.get(key) ?? [];
    list.push(edge);
    paired.set(key, list);
  }
  for (const [key, edges] of paired) {
    const starts = edges.filter((edge) => edge.edge === 'before');
    const afters = edges.filter((edge) => edge.edge === 'after');
    const before = starts[0];
    const after = afters[0];
    const edge = before ?? after;
    if (!edge) continue;
    const decision = decided.get(JSON.stringify([edge.owner, edge.runtime, edge.actor, edge.call]));
    const closed =
      starts.length === 1 &&
      afters.length === 1 &&
      before &&
      after &&
      !after.pending &&
      before.end <= after.start;
    const stopped = (stops.get(key) ?? []).filter((at) => at >= (after?.end ?? before?.end ?? 0));
    const end = closed
      ? after.end
      : stopped.length
        ? Math.min(runtimeEnd(edge.runtime), ...stopped)
        : runtimeEnd(edge.runtime);
    let start = before?.start ?? after?.start ?? 0;
    if (
      decision &&
      !conflicting.has(JSON.stringify([decision.owner, decision.runtime, decision.turn]))
    ) {
      if (closed && start >= decision.start && end <= decision.end && decision.source !== 'none')
        continue;
      if (decision.source === 'turn' && decision.floor && start >= decision.start)
        start = Math.max(start, decision.end);
    }
    if (end > start) windows.push({ sid: edge.owner, start, end, paths: [], uncertain: true });
  }
  return { ...source, windows };
}

function objectIn(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function identityIn(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function orderedTimes(start: unknown, end: unknown): boolean {
  return (
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start <= end
  );
}

function executionSnapshotIn(value: unknown): checkpointModel.Snapshot | undefined {
  const shot = objectIn(value);
  if (
    !shot ||
    typeof shot.tree !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(shot.tree) ||
    typeof shot.at !== 'number' ||
    !Number.isFinite(shot.at)
  )
    return undefined;
  if (
    shot.head !== undefined &&
    (typeof shot.head !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(shot.head))
  )
    return undefined;
  if (shot.startedAt !== undefined && !orderedTimes(shot.startedAt, shot.at)) return undefined;
  if (shot.op !== undefined && (!identityIn(shot.op) || shot.op.length > 40)) return undefined;
  return {
    tree: shot.tree,
    at: shot.at,
    ...(shot.head === undefined ? {} : { head: shot.head }),
    ...(shot.startedAt === undefined ? {} : { startedAt: shot.startedAt as number }),
    ...(shot.op === undefined ? {} : { op: shot.op })
  };
}

function executionCheckpointIn(
  value: unknown,
  treeRoot: string
): checkpointModel.TurnCheckpoint | undefined {
  const ck = objectIn(value);
  if (!ck || ck.tree !== treeRoot) return undefined;
  const from = executionSnapshotIn(ck.from);
  const to = executionSnapshotIn(ck.to);
  const changes = objectIn(ck.changes);
  if (
    !from ||
    !to ||
    !orderedTimes(from.startedAt ?? from.at, to.at) ||
    !changes ||
    !Array.isArray(changes.files)
  )
    return undefined;
  const aliases = Array.isArray(ck.aliases)
    ? ck.aliases.filter((root): root is string => typeof root === 'string' && path.isAbsolute(root))
    : [];
  const files = changes.files.filter(
    (file): file is string => typeof file === 'string' && path.isAbsolute(file)
  );
  if (
    files.length !== changes.files.length ||
    files.some((file) => {
      const relative = path.relative(treeRoot, fileIdentity(treeRoot, file, aliases));
      return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    })
  )
    return undefined;
  const sizes: Record<string, Written> = {};
  const counts = objectIn(changes.sizes);
  if (!counts) return undefined;
  for (const [file, value] of Object.entries(counts)) {
    const size = objectIn(value);
    if (
      !files.includes(file) ||
      !size ||
      typeof size.add !== 'number' ||
      typeof size.del !== 'number' ||
      !Number.isSafeInteger(size.add) ||
      !Number.isSafeInteger(size.del) ||
      size.add < 0 ||
      size.del < 0
    )
      return undefined;
    sizes[file] = { add: size.add, del: size.del };
  }
  const moves =
    Array.isArray(ck.moves) && ck.moves.every((move) => typeof move === 'string')
      ? ck.moves
      : undefined;
  return {
    tree: treeRoot,
    from,
    to,
    changes: { files, sizes },
    ...(aliases.length ? { aliases } : {}),
    ...(moves === undefined ? {} : { moves })
  };
}

export function executionEvidenceIn(
  value: unknown,
  treeRoot: string
): checkpointModel.ExecutionEvidence | undefined {
  const row = objectIn(value);
  if (
    !row ||
    row.version !== 1 ||
    typeof row.tree !== 'string' ||
    fileIdentity(treeRoot, row.tree) !== fileIdentity(treeRoot, treeRoot) ||
    !identityIn(row.runtime)
  )
    return undefined;
  const tree = row.tree;
  const runtime = row.runtime;
  if (row.kind === 'runtime-end') {
    return typeof row.at === 'number' && Number.isFinite(row.at)
      ? { version: 1, kind: 'runtime-end', tree, runtime, at: row.at }
      : undefined;
  }
  if (!identityIn(row.owner)) return undefined;
  const owner = row.owner;
  if (row.kind === 'call-end') {
    return identityIn(row.actor) &&
      identityIn(row.call) &&
      typeof row.at === 'number' &&
      Number.isFinite(row.at)
      ? {
          version: 1,
          kind: 'call-end',
          tree,
          runtime,
          owner,
          actor: row.actor,
          call: row.call,
          at: row.at
        }
      : undefined;
  }
  if (row.kind === 'active') {
    return identityIn(row.turn) && typeof row.start === 'number' && Number.isFinite(row.start)
      ? { version: 1, kind: 'active', tree, runtime, owner, turn: row.turn, start: row.start }
      : undefined;
  }
  if (!orderedTimes(row.start, row.end)) return undefined;
  const start = row.start as number;
  const end = row.end as number;
  if (row.kind === 'execution') {
    if (
      !identityIn(row.actor) ||
      !identityIn(row.call) ||
      (row.edge !== 'before' && row.edge !== 'after') ||
      (row.context !== undefined && !identityIn(row.context)) ||
      (row.task !== undefined && !identityIn(row.task)) ||
      (row.pending !== undefined && row.pending !== true)
    )
      return undefined;
    const snapshot = row.snapshot === undefined ? undefined : executionSnapshotIn(row.snapshot);
    if (
      (row.snapshot !== undefined && !snapshot) ||
      (snapshot && (snapshot.at < start || snapshot.at > end))
    )
      return undefined;
    return {
      version: 1,
      kind: 'execution',
      tree,
      runtime,
      owner,
      actor: row.actor,
      call: row.call,
      edge: row.edge,
      start,
      end,
      ...(row.context === undefined ? {} : { context: row.context }),
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(row.pending === true ? { pending: true } : {}),
      ...(row.task === undefined ? {} : { task: row.task })
    };
  }
  if (
    row.kind !== 'coverage' ||
    !identityIn(row.turn) ||
    !['execution', 'turn', 'none'].includes(String(row.source)) ||
    !Array.isArray(row.windows) ||
    !Array.isArray(row.calls)
  )
    return undefined;
  const windows: checkpointModel.TurnCheckpoint[] = [];
  for (const value of row.windows) {
    const window = executionCheckpointIn(value, tree);
    if (!window || (window.from.startedAt ?? window.from.at) < start || window.to.at > end)
      return undefined;
    windows.push(window);
  }
  const calls: { actor: string; call: string }[] = [];
  for (const value of row.calls) {
    const call = objectIn(value);
    if (!call || !identityIn(call.actor) || !identityIn(call.call)) return undefined;
    calls.push({ actor: call.actor, call: call.call });
  }
  const floor = row.floor === undefined ? undefined : executionCheckpointIn(row.floor, tree);
  if (row.floor !== undefined && !floor) return undefined;
  if (row.source === 'none' && windows.length) return undefined;
  if (
    row.source === 'turn' &&
    (!floor || windows.length !== 1 || JSON.stringify(windows[0]) !== JSON.stringify(floor))
  )
    return undefined;
  return {
    version: 1,
    kind: 'coverage',
    tree,
    runtime,
    owner,
    turn: row.turn,
    start,
    end,
    source: row.source as checkpointModel.ExecutionCoverage['source'],
    windows,
    calls,
    ...(floor === undefined ? {} : { floor })
  };
}

const EMPTY: checkpointModel.TurnWindow[] = [];

const UNREADABLE_WINDOWS: checkpointModel.TurnWindow[] = [
  { sid: '', start: -Infinity, end: Infinity, paths: [], unavailable: true }
];

const EMPTY_STORE: ParsedExecutionStore = {
  readable: true,
  legacy: [],
  edges: [],
  coverage: [],
  active: [],
  ended: [],
  callEnds: [],
  windows: EMPTY
};

const UNREADABLE_STORE: ParsedExecutionStore = {
  ...EMPTY_STORE,
  readable: false,
  windows: UNREADABLE_WINDOWS
};

export function appendRuntimeNote(contextFile: string, note: RuntimeNote): Promise<void> {
  return fs.appendFile(`${contextFile}.trees`, `${JSON.stringify(note)}\n`, { mode: 0o600 });
}

export async function readRuntimeTrees(contextFile: string, runtime: string): Promise<string[]> {
  const roots: string[] = [];
  for (const note of (await readRuntimeNotes(contextFile)) ?? [])
    if (typeof note === 'string') roots.push(note);
    else if (note.kind === 'capture' && note.runtime === runtime) roots.push(note.tree);
  return roots;
}
