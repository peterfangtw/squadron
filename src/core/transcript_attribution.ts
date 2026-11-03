import * as checkpoint from './checkpoint';
import * as git from './git';
import type { Recorded } from './record';
import type { Exchange, Recent, Written } from './transcript';

/**
 * Attribute checkpoints after source selection, where record and CLI file meet in one
 * Recent; another merge site would add a data layer with its own cache and drift.
 * Recompute rather than store: claims depend on neighbours whose mid-turn
 * windows are not written yet, so a frozen verdict would be stale.
 * It self-corrects as neighbours finish. Only checkpoint pills are recovered:
 * a turn whose record loses to the CLI file (a conversation resumed outside
 * the panel or a session attached late) has no ck notes and draws none.
 * This keeps the same one-source degradation as drawable.
 */
export async function claimed(
  owner: string,
  sessionId: string,
  drawn: Recent,
  mine: Pick<Recorded, 'checkpoints' | 'execution'> | undefined
): Promise<Recent> {
  const checkpoints = mine?.checkpoints;
  const execution = mine?.execution;
  if (!checkpoints?.size && !execution?.size) {
    return drawn;
  }
  const captures = [
    ...[...(checkpoints?.values() ?? [])],
    ...[...(execution?.values() ?? [])].flatMap((ex) => [
      ...ex.windows,
      ...(ex.floor ? [ex.floor] : [])
    ])
  ];
  const trees = [
    ...new Set([
      ...[...(checkpoints?.values() ?? [])].map((ck) => ck.tree),
      ...[...(execution?.values() ?? [])].map((ex) => ex.tree)
    ])
  ].sort();
  // Each of these is `readWindows`' cached array, stable while its file has not
  // moved — which is what the memo below compares.
  const windows = await Promise.all(
    trees.map((tree) =>
      checkpoint.readWindows(
        tree,
        captures.filter((ck) => ck.tree === tree).flatMap((ck) => ck.aliases ?? [])
      )
    )
  );
  const byTree = new Map(trees.map((tree, i) => [tree, windows[i] ?? []]));

  const hit = merged.get(owner);
  if (
    hit &&
    hit.from === drawn &&
    hit.checkpoints === checkpoints &&
    hit.execution === execution &&
    hit.windows.length === windows.length &&
    hit.windows.every((was, i) => was === windows[i])
  ) {
    return hit.recent;
  }
  const recent = withCheckpoints(
    owner,
    sessionId,
    drawn,
    checkpoints ?? new Map(),
    byTree,
    execution
  );
  merged.set(owner, { from: drawn, checkpoints, execution, windows, recent });
  return recent;
}

/**
 * `claimed`'s answer, remembered while none of its three inputs has moved.
 *
 * The third one is why this exists rather than riding `drawableFor`'s memo. That
 * cache keys on the *object identity* of the record and the CLI's file, which is
 * what lets `renderTranscript` skip its ~148 KB view rebuild on a poll that
 * changed nothing — and a neighbour's window file is an input neither of those
 * stamps can see. Left out, either the corrected attribution never repaints when
 * a neighbour finishes, or a fresh object every poll repaints the thread every
 * 3s. One entry per conversation ever drawn; dies with the panel.
 */
const merged = new Map<
  string,
  {
    from: Recent;
    checkpoints: ReadonlyMap<Exchange, checkpoint.TurnCheckpoint> | undefined;
    execution: ReadonlyMap<Exchange, checkpoint.ExecutionCoverage> | undefined;
    windows: readonly (readonly checkpoint.TurnWindow[])[];
    recent: Recent;
  }
>();

/**
 * Turns run prompt to prompt: a Write on the third exchange and a checkpoint
 * on the seventh describe one file in one turn; splitting them draws two pills.
 */
function opensTurn(x: Exchange): boolean {
  return 'role' in x && x.role === 'user';
}

function withCheckpoints(
  owner: string,
  sessionId: string,
  drawn: Recent,
  checkpoints: ReadonlyMap<Exchange, checkpoint.TurnCheckpoint>,
  byTree: ReadonlyMap<string, readonly checkpoint.TurnWindow[]>,
  execution?: ReadonlyMap<Exchange, checkpoint.ExecutionCoverage>
): Recent {
  const out = [...drawn.exchanges];
  for (let start = 0; start < out.length;) {
    let end = start + 1;
    while (end < out.length) {
      const next = out[end];
      if (next && opensTurn(next)) {
        break;
      }
      end++;
    }
    // Keep the last checkpoint, matching readRecord's last-per-exchange rule.
    // Only one reaches a span because each drain takes and consumes one baseline;
    // last-at-turn-grain also holds if that changes.
    let baseline: string | undefined;
    let found:
      { at: number; ck?: checkpoint.TurnCheckpoint; ex?: checkpoint.ExecutionCoverage } | undefined;
    for (let i = start; i < end; i++) {
      const x = out[i];
      const ck = x && checkpoints.get(x);
      if (ck) baseline = ck.from.tree;
      const decision = x && execution?.get(x);
      const ex = decision?.owner === owner ? decision : undefined;
      if (ck || ex) {
        found = { at: i, ...(ck ? { ck } : {}), ...(ex ? { ex } : {}) };
      }
    }
    if (found) {
      claim(
        out,
        start,
        end,
        found,
        owner,
        sessionId,
        byTree.get(found.ex?.tree ?? found.ck?.tree ?? '') ?? [],
        baseline ?? found.ex?.floor?.from.tree
      );
    }
    start = end;
  }
  return out.every((x, i) => x === drawn.exchanges[i]) ? drawn : { ...drawn, exchanges: out };
}

/**
 * A Git total belongs to the last exchange naming its file. Consolidate earlier
 * pills there too, so folds sum the total exactly once.
 * Unattributed paths keep their tool evidence; shell-only paths land with the checkpoint.
 */
function claim(
  out: Exchange[],
  start: number,
  end: number,
  found: { at: number; ck?: checkpoint.TurnCheckpoint; ex?: checkpoint.ExecutionCoverage },
  owner: string,
  sessionId: string,
  windows: readonly checkpoint.TurnWindow[],
  base: string | undefined
): void {
  if (base !== undefined) {
    for (let i = start; i < end; i++) {
      const exchange = out[i];
      if (exchange && !('mark' in exchange) && exchange.base !== base) {
        out[i] = { ...exchange, base };
      }
    }
  }
  const resolved = resolveAttribution(found, owner, sessionId, windows);
  if (!resolved) return;
  const { tree, aliases, files: attributedFiles, counts, concurrent } = resolved;
  const seen = new Set<string>();
  for (let i = end - 1; i >= start; i--) {
    const exchange = out[i];
    if (!exchange || 'mark' in exchange) continue;
    let sizes: Record<string, Written> | undefined;
    const files: string[] = [];
    for (const file of exchange.files ?? []) {
      const identity = git.fileIdentity(tree, file, aliases);
      if (counts.has(identity)) {
        const size = seen.has(identity) ? undefined : counts.get(identity);
        sizes ??= { ...(exchange.sizes ?? {}) };
        if (size) sizes[file] = size;
        else delete sizes[file];
        if (!seen.has(identity)) files.push(file);
      } else files.push(file);
      seen.add(identity);
    }
    if (sizes) out[i] = { ...exchange, files, sizes };
  }
  const fresh = attributedFiles.filter((file) => !seen.has(git.fileIdentity(tree, file, aliases)));
  const exchange = out[found.at];
  if (!exchange || 'mark' in exchange || (!fresh.length && !concurrent)) {
    return;
  }
  const sizes = { ...(exchange.sizes ?? {}) };
  for (const file of fresh) {
    const size = counts.get(git.fileIdentity(tree, file, aliases));
    if (size) {
      sizes[file] = size;
    }
  }
  out[found.at] = {
    ...exchange,
    ...(fresh.length ? { files: [...(exchange.files ?? []), ...fresh] } : {}),
    ...(Object.keys(sizes).length ? { sizes } : {}),
    ...(concurrent ? { concurrent: true as const } : {})
  };
}

type ResolvedAttribution = {
  tree: string;
  aliases: readonly string[] | undefined;
  files: readonly string[];
  counts: ReadonlyMap<string, Written | undefined>;
  concurrent: true | undefined;
};

function resolveAttribution(
  found: { ck?: checkpoint.TurnCheckpoint; ex?: checkpoint.ExecutionCoverage },
  owner: string,
  sessionId: string,
  windows: readonly checkpoint.TurnWindow[]
): ResolvedAttribution | undefined {
  const tree = found.ex?.tree ?? found.ck?.tree;
  if (!tree) return;
  const aliases = found.ex
    ? [
        ...new Set([
          ...(found.ex.floor?.aliases ?? []),
          ...found.ex.windows.flatMap((window) => window.aliases ?? [])
        ])
      ]
    : found.ck?.aliases;
  const attributed = found.ex
    ? checkpoint.attributeExecution(found.ex, windows)
    : found.ck
      ? checkpoint.attribute(found.ck, owner, windows, sessionId)
      : undefined;
  if (!attributed) return;
  const wholeTurn = found.ex ? found.ex.floor : found.ck;
  // Whole-turn pairs count net changes, including writes between tool windows.
  const net = wholeTurn
    ? checkpoint.attribute(
        found.ex ? withUnchangedExecutionFiles(wholeTurn, attributed.files, aliases) : wholeTurn,
        owner,
        windows,
        sessionId
      )
    : undefined;
  const netCounts = new Map(
    net?.files.map((file) => [git.fileIdentity(tree, file, aliases), net.sizes[file]])
  );
  const counts = new Map<string, Written | undefined>();
  for (const file of attributed.files) {
    const identity = git.fileIdentity(tree, file, aliases);
    const size = netCounts.has(identity) ? netCounts.get(identity) : attributed.sizes[file];
    // Only an actual Git pair identifies a missing numeric size as binary.
    if (size || netCounts.has(identity)) counts.set(identity, size);
  }
  return { tree, aliases, files: attributed.files, counts, concurrent: attributed.concurrent };
}

/** Execution windows prove membership in this tree; absence from its turn diff means zero net change. */
function withUnchangedExecutionFiles(
  wholeTurn: checkpoint.TurnCheckpoint,
  files: readonly string[],
  aliases: readonly string[] | undefined
): checkpoint.TurnCheckpoint {
  const changed = new Set(
    wholeTurn.changes.files.map((file) => git.fileIdentity(wholeTurn.tree, file, aliases))
  );
  const unchanged = files.filter(
    (file) => !changed.has(git.fileIdentity(wholeTurn.tree, file, aliases))
  );
  if (!unchanged.length) return wholeTurn;
  return {
    ...wholeTurn,
    changes: {
      files: [...wholeTurn.changes.files, ...unchanged],
      sizes: {
        ...wholeTurn.changes.sizes,
        ...Object.fromEntries(unchanged.map((file) => [file, { add: 0, del: 0 }]))
      }
    }
  };
}
