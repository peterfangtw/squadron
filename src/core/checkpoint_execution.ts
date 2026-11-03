import * as execution from './execution';
import { readTree, treeAliases } from './git';
import * as checkpointModel from './checkpoint_model';
import * as checkpointGit from './checkpoint_git';
import * as checkpointJournal from './checkpoint_journal';

export async function captureExecution(
  request: checkpointModel.ExecutionRequest,
  contextFile?: string
): Promise<checkpointModel.ExecutionBoundary | undefined> {
  const start = Date.now();
  const tree = await readTree(request.cwd);
  if (!tree) return undefined;
  const key = checkpointModel.executionKey({ ...request, tree: tree.treeRoot });
  const master = contextFile
    ? checkpointModel.executionMasterKey({ ...request, tree: tree.treeRoot })
    : undefined;
  // Shutdown can precede edge publication; register the index before starting Git.
  if (contextFile) {
    try {
      await checkpointJournal.appendRuntimeNote(contextFile, {
        kind: 'capture',
        tree: tree.treeRoot,
        owner: request.owner,
        runtime: request.runtime,
        actor: request.actor,
        call: request.call
      });
    } catch {
      return undefined;
    }
    if (
      runtimeEnded(await checkpointJournal.readRuntimeNotes(contextFile), request.runtime) ||
      (await checkpointJournal.readExecution(tree.treeRoot)).ended.some(
        (end) => end.runtime === request.runtime
      )
    )
      return undefined;
  }
  const seeded =
    master && request.edge === 'before'
      ? await checkpointGit.copyIndex(tree, master, key, 'seed')
      : false;
  if (
    contextFile &&
    runtimeEnded(await checkpointJournal.readRuntimeNotes(contextFile), request.runtime)
  ) {
    await checkpointGit.forgetIndex(tree, key);
    return undefined;
  }
  let snapshot = await checkpointGit.capture(tree, key);
  if (!snapshot && seeded && (await checkpointGit.discardFailedSeed(tree, key))) {
    if (
      !contextFile ||
      !runtimeEnded(await checkpointJournal.readRuntimeNotes(contextFile), request.runtime)
    )
      snapshot = await checkpointGit.capture(tree, key);
  }

  if (
    contextFile &&
    runtimeEnded(await checkpointJournal.readRuntimeNotes(contextFile), request.runtime)
  ) {
    await checkpointGit.forgetIndex(tree, key);
    return undefined;
  }
  const edge: checkpointModel.ExecutionBoundary = {
    version: 1,
    kind: 'execution',
    tree: tree.treeRoot,
    owner: request.owner,
    runtime: request.runtime,
    actor: request.actor,
    call: request.call,
    ...(request.context === undefined ? {} : { context: request.context }),
    edge: request.edge,
    start,
    end: Date.now(),
    ...(snapshot ? { snapshot } : {}),
    ...(request.pending ? { pending: true } : {}),
    ...(request.task ? { task: request.task } : {})
  };
  await checkpointJournal.appendExecution(tree.treeRoot, edge);
  const notes = contextFile ? await checkpointJournal.readRuntimeNotes(contextFile) : [];
  if (master && snapshot && request.edge === 'after' && !runtimeEnded(notes, request.runtime)) {
    await checkpointGit.copyIndex(tree, key, master, 'publish');
    if (
      contextFile &&
      runtimeEnded(await checkpointJournal.readRuntimeNotes(contextFile), request.runtime)
    )
      await checkpointGit.forgetIndex(tree, checkpointModel.executionMasterKey(edge));
  }
  const children =
    contextFile && edge.task ? await execution.readExecutionChildren(contextFile) : [];
  const endedAt = pendingEnd(edge, notes ?? [], children);
  if (endedAt !== undefined)
    await checkpointJournal.appendExecution(edge.tree, {
      version: 1,
      kind: 'call-end',
      tree: edge.tree,
      owner: edge.owner,
      runtime: edge.runtime,
      actor: edge.actor,
      call: edge.call,
      at: endedAt
    });
  if (
    request.edge === 'after' ||
    (contextFile && runtimeEnded(notes, request.runtime)) ||
    (await checkpointJournal.readExecution(tree.treeRoot)).ended.some(
      (end) => end.runtime === request.runtime
    )
  )
    await checkpointGit.forgetIndex(tree, key);
  return edge;
}

function runtimeEnded(
  notes: readonly checkpointJournal.RuntimeNote[] | undefined,
  runtime: string
): boolean {
  return (
    notes === undefined ||
    notes.some(
      (note) => typeof note !== 'string' && note.kind === 'runtime-end' && note.runtime === runtime
    )
  );
}

/** A task ending reported by `reporter` covers its own calls and its proven descendants'. */
function reportedBy(
  children: readonly execution.ExecutionChild[],
  reporter: string,
  actor: string
): boolean {
  return actor === reporter || execution.executionChildFor(children, reporter, actor) !== undefined;
}

function pendingEnd(
  edge: checkpointModel.ExecutionBoundary,
  notes: readonly checkpointJournal.RuntimeNote[],
  children: readonly execution.ExecutionChild[]
): number | undefined {
  if (edge.edge !== 'after' || !edge.pending || !edge.task) return undefined;
  const ends = notes.flatMap((note) =>
    typeof note !== 'string' &&
    note.kind === 'task-end' &&
    note.owner === edge.owner &&
    note.runtime === edge.runtime &&
    reportedBy(children, note.actor, edge.actor) &&
    note.task === edge.task
      ? [note.at]
      : []
  );
  return ends.length ? Math.max(edge.end, Math.min(...ends)) : undefined;
}

export async function endPendingExecution(
  cwd: string,
  owner: string,
  runtime: string,
  task: string,
  scope?: { contextFile: string; actor: string }
): Promise<void> {
  const at = Date.now();
  let notes: checkpointJournal.RuntimeNote[] = [];
  let children: execution.ExecutionChild[] = [];
  const roots = new Set([cwd]);
  if (scope) {
    try {
      // Completion and hook writers publish before joining; either arrival order retains the ending.
      await checkpointJournal.appendRuntimeNote(scope.contextFile, {
        kind: 'task-end',
        owner,
        runtime,
        actor: scope.actor,
        task,
        at
      });
    } catch {
      /* Published edges can still be bounded when the private journal is unavailable. */
    }
    notes = (await checkpointJournal.readRuntimeNotes(scope.contextFile)) ?? [];
    children = await execution.readExecutionChildren(scope.contextFile);
    for (const note of notes)
      if (
        typeof note !== 'string' &&
        note.kind === 'capture' &&
        note.owner === owner &&
        note.runtime === runtime &&
        reportedBy(children, scope.actor, note.actor)
      )
        roots.add(note.tree);
  }
  for (const root of roots) {
    const store = await checkpointJournal.readExecution(root);
    for (const edge of store.edges) {
      if (
        edge.edge !== 'after' ||
        edge.owner !== owner ||
        edge.runtime !== runtime ||
        !edge.pending ||
        edge.task !== task ||
        (scope && !reportedBy(children, scope.actor, edge.actor))
      )
        continue;
      await checkpointJournal.appendExecution(edge.tree, {
        version: 1,
        kind: 'call-end',
        tree: edge.tree,
        owner,
        runtime,
        actor: edge.actor,
        call: edge.call,
        at: pendingEnd(edge, notes, children) ?? Math.max(edge.end, at)
      });
    }
  }
}

/**
 * Ends a runtime whose host cannot: one that died, or one closing behind a slow
 * final capture. Its active rows otherwise read as uncertain until Infinity and
 * blank every other session's inferred pills on those trees. Idempotent — an
 * ending already on a tree is kept, so a sweep every activation repeats cannot
 * move the bound later.
 */
export function endExecutionRuntime(runtime: string, contextFile: string): Promise<void> {
  return endRuntime(runtime, contextFile, [], true);
}

export async function endRuntime(
  runtime: string,
  contextFile: string | undefined,
  known: Iterable<string>,
  once: boolean
): Promise<void> {
  const roots = new Set(known);
  const registered = new Map<string, Set<string>>();
  if (contextFile) {
    if (
      !once ||
      !runtimeEnded((await checkpointJournal.readRuntimeNotes(contextFile)) ?? [], runtime)
    ) {
      try {
        await checkpointJournal.appendRuntimeNote(contextFile, {
          kind: 'runtime-end',
          runtime,
          at: Date.now()
        });
      } catch {
        /* A removed runtime directory also prevents new index registrations. */
      }
    }
    for (const note of (await checkpointJournal.readRuntimeNotes(contextFile)) ?? []) {
      if (typeof note === 'string') {
        roots.add(note);
      } else if (note.kind === 'capture' && note.runtime === runtime) {
        roots.add(note.tree);
        const keys = registered.get(note.tree) ?? new Set<string>();
        keys.add(checkpointModel.executionKey(note));
        keys.add(checkpointModel.executionMasterKey(note));
        registered.set(note.tree, keys);
      }
    }
  }
  for (const root of roots) {
    if (
      !once ||
      !(await checkpointJournal.readExecution(root)).ended.some((end) => end.runtime === runtime)
    )
      await checkpointJournal.appendExecution(root, {
        version: 1,
        kind: 'runtime-end',
        tree: root,
        runtime,
        at: Date.now()
      });
    const tree = await readTree(root);
    if (!tree) continue;
    const store = await checkpointJournal.readExecution(root);
    const keys = new Set([
      ...(registered.get(root) ?? []),
      ...store.edges
        .filter((edge) => edge.runtime === runtime)
        .flatMap((edge) => [
          checkpointModel.executionKey(edge),
          checkpointModel.executionMasterKey(edge)
        ])
    ]);
    await Promise.all([...keys].map((key) => checkpointGit.forgetIndex(tree, key)));
  }
}

/**
 * The turn is over, so its calls are: an interrupt, a hook timeout or capture
 * turned off mid-call leaves an edge no partner will follow. `store` is one tree;
 * the caller passes each tree the runtime registered. Bounded only for a
 * call the turn saw return, or for every call once the turn completed with no
 * native child still running — a background child's call waits for its own end.
 */
export async function endUnpaired(
  turn: Pick<checkpointModel.ExecutionTurn, 'owner' | 'runtime'>,
  store: checkpointModel.ExecutionStore,
  observed: { observed: boolean; calls: readonly checkpointModel.ExecutionCall[] },
  at: number
): Promise<void> {
  const done = new Set(
    observed.calls.filter((call) => observed.observed || call.settled).map(checkpointModel.callKey)
  );
  const stopped = new Set(store.callEnds.map(checkpointModel.executionKey));
  const open = new Map<string, checkpointModel.ExecutionBoundary[]>();
  for (const edge of store.edges) {
    if (
      edge.owner !== turn.owner ||
      edge.runtime !== turn.runtime ||
      !done.has(checkpointModel.callKey(edge))
    )
      continue;
    const key = checkpointModel.executionKey(edge);
    open.set(key, [...(open.get(key) ?? []), edge]);
  }
  for (const [key, edges] of open) {
    const [edge] = edges;
    if (
      !edge ||
      stopped.has(key) ||
      edges.some((one) => one.edge === 'after' && one.pending) ||
      (edges.some((one) => one.edge === 'before') && edges.some((one) => one.edge === 'after'))
    )
      continue;
    await checkpointJournal.appendExecution(edge.tree, {
      version: 1,
      kind: 'call-end',
      tree: edge.tree,
      owner: edge.owner,
      runtime: edge.runtime,
      actor: edge.actor,
      call: edge.call,
      at: Math.max(at, ...edges.map((one) => one.end))
    });
  }
}

export async function selectExecution(
  turn: checkpointModel.ExecutionTurn,
  boundaries: readonly checkpointModel.ExecutionBoundary[]
): Promise<checkpointModel.ExecutionCoverage> {
  const fallback: checkpointModel.ExecutionCoverage = {
    version: 1,
    kind: 'coverage',
    owner: turn.owner,
    runtime: turn.runtime,
    turn: turn.turn,
    tree: turn.tree,
    start: turn.start,
    end: turn.end,
    source: turn.floor ? 'turn' : 'none',
    windows: turn.floor ? [turn.floor] : [],
    calls: turn.calls.map(({ actor, call }) => ({ actor, call })),
    ...(turn.floor ? { floor: turn.floor } : {})
  };
  if (
    !turn.observed ||
    turn.calls.some((call) => !call.settled || call.eligibility === 'unknown')
  ) {
    return fallback;
  }
  const observed = new Set(turn.calls.map(checkpointModel.callKey));
  const relevant = boundaries.filter(
    (edge) => edge.owner === turn.owner && edge.runtime === turn.runtime
  );
  if (
    relevant.some(
      (edge) =>
        edge.start < turn.end &&
        edge.end > turn.start &&
        !observed.has(checkpointModel.callKey(edge))
    )
  ) {
    return fallback;
  }
  const windows: checkpointModel.TurnCheckpoint[] = [];
  for (const call of turn.calls) {
    if (call.eligibility !== 'write') continue;
    const edges = relevant.filter(
      (edge) =>
        checkpointModel.callKey(edge) === checkpointModel.callKey(call) && edge.tree === turn.tree
    );
    const starts = edges.filter((edge) => edge.edge === 'before');
    const ends = edges.filter((edge) => edge.edge === 'after');
    const before = starts[0];
    const after = ends[0];
    if (
      starts.length !== 1 ||
      ends.length !== 1 ||
      !before?.snapshot ||
      !after?.snapshot ||
      before.pending ||
      after.pending ||
      before.end > after.start ||
      before.start < turn.start ||
      after.end > turn.end ||
      before.context !== after.context ||
      (call.context !== undefined && before.context !== call.context) ||
      ![before.start, before.end, after.start, after.end].every(Number.isFinite) ||
      before.start > before.end ||
      after.start > after.end ||
      before.snapshot.at < before.start ||
      before.snapshot.at > before.end ||
      after.snapshot.at < after.start ||
      after.snapshot.at > after.end
    )
      return fallback;
    const tree = await readTree(turn.tree);
    if (!tree && before.snapshot.tree !== after.snapshot.tree) return fallback;
    const location = tree ?? { treeRoot: turn.tree, gitDir: '' };
    const changes = await checkpointGit.changesBetween(
      location,
      before.snapshot.tree,
      after.snapshot.tree
    );
    if (!changes) return fallback;
    const moves =
      before.snapshot.head !== undefined && after.snapshot.head !== undefined
        ? await checkpointGit.headMoves(location, before.snapshot.head, after.snapshot.head)
        : undefined;
    const aliases = [
      ...new Set([...treeAliases(turn.tree), ...(turn.floor?.aliases ?? [])])
    ].filter((root) => root !== turn.tree);
    windows.push({
      tree: turn.tree,
      ...(aliases.length ? { aliases } : {}),
      from: { ...before.snapshot, startedAt: before.start },
      to: { ...after.snapshot, at: after.end },
      changes,
      ...(moves === undefined ? {} : { moves })
    });
  }
  return { ...fallback, source: 'execution', windows };
}
