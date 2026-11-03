import { readTree, treeAliases, type Tree } from './git';
import * as checkpointModel from './checkpoint_model';
import * as checkpointJournal from './checkpoint_journal';
import * as checkpointGit from './checkpoint_git';
import * as checkpointExecution from './checkpoint_execution';
export {
  type Snapshot,
  type TurnChanges,
  type TurnWindow,
  type ExecutionBoundary,
  type ExecutionCall,
  type ExecutionTurn,
  type ExecutionCoverage,
  type ExecutionActive,
  type ExecutionEnd,
  type ExecutionCallEnd,
  type ExecutionEvidence,
  type ExecutionStore,
  type ExecutionRequest,
  executionKey,
  type TurnCheckpoint,
  type Attributed
} from './checkpoint_model';
export { capture, changesBetween, headMoves, forgetIndex } from './checkpoint_git';
export {
  appendExecution,
  readExecution,
  windowsFile,
  appendWindow,
  readWindows,
  executionEvidenceIn
} from './checkpoint_journal';
export {
  captureExecution,
  endPendingExecution,
  endExecutionRuntime,
  selectExecution
} from './checkpoint_execution';
export { attributeExecution, attribute } from './checkpoint_attribution';

/**
 * Share turn-boundary rules across brands so each session need not maintain
 * its own baseline and rules.
 *
 * **Every capture for one owner is serialised here**, which is the caller
 * `indexFile` names: two `git add`s on one index race for `index.lock` and the
 * loser answers nothing. The chain is what makes that impossible rather than
 * unlikely.
 * Re-baseline every turn for owned sessions (plan rules 1 and 4).
 * `attribute` applies rules 2 and 3 on reads because neighbours can finish later.
 */
export class TurnCheckpoints {
  private baseline?: { tree: Tree; snap: checkpointModel.Snapshot };
  private seen?: Tree;
  private chain: Promise<unknown> = Promise.resolve();
  private execution?: Omit<checkpointModel.ExecutionTurn, 'end' | 'floor' | 'calls'>;
  private readonly executionTrees = new Set<string>();

  /** `owner` scopes the index — the session id, so a poisoned one costs a
   *  session rather than a checkout. `journal` is the runtime's context file,
   *  whose tree log lets `endExecutionRuntime` reach an active row after a crash. */
  constructor(
    private readonly owner: string,
    private readonly journal?: string
  ) {}

  /**
   * Rule 1: baseline this turn, **unconditionally**, before it is released.
   *
   * The unconditional part is the whole rule. `t3code`'s `ensurePreTurnBaseline`
   * opens `if (baselineExists) return`, so from turn 2 its baseline is frozen at
   * the previous turn's *completion* and every idle gap between turns is charged
   * to whoever speaks next — a reader who edits a file in their editor over
   * lunch has it appear as the next turn's work. Read, not copied.
   *
   * Never throws and answers nothing: a tree that cannot be captured leaves no
   * baseline, and the turn simply draws no checkpoint pills.
   */
  open(
    cwd: string,
    context?: { owner: string; runtime: string; turn: string; enabled: boolean }
  ): Promise<void> {
    return this.begin(cwd, context, true);
  }

  openUnknown(
    cwd: string,
    context: { owner: string; runtime: string; turn: string }
  ): Promise<void> {
    return this.begin(cwd, { ...context, enabled: false }, false);
  }

  // A native wake can run while an unsent prompt prepares its baseline or model.
  // Its uncertainty must survive prompt discard, and that contaminated floor is invalid.
  uncertainExecution(
    cwd: string,
    context: { owner: string; runtime: string; turn: string }
  ): () => void {
    const start = Date.now();
    let tree: Tree | undefined;
    let ended = false;
    void this.serialise(async () => {
      this.baseline = undefined;
      tree = await readTree(cwd);
      if (!tree) return;
      await this.track(tree.treeRoot);
      await checkpointJournal.appendExecution(tree.treeRoot, {
        version: 1,
        kind: 'active',
        tree: tree.treeRoot,
        ...context,
        start
      });
    });
    return () => {
      if (ended) return;
      ended = true;
      const end = Date.now();
      void this.serialise(async () => {
        if (!tree) return;
        await checkpointJournal.appendExecution(tree.treeRoot, {
          version: 1,
          kind: 'coverage',
          tree: tree.treeRoot,
          ...context,
          start,
          end,
          source: 'none',
          windows: [],
          calls: []
        });
      });
    };
  }

  private async begin(
    cwd: string,
    context: { owner: string; runtime: string; turn: string; enabled: boolean } | undefined,
    baseline: boolean
  ): Promise<void> {
    const start = Date.now();
    await this.serialise(async () => {
      this.baseline = undefined;
      this.execution = undefined;
      const tree = await readTree(cwd);
      if (!tree) {
        return;
      }
      this.seen = tree;
      if (context) {
        this.execution = {
          owner: context.owner,
          runtime: context.runtime,
          turn: context.turn,
          tree: tree.treeRoot,
          start,
          observed: context.enabled
        };
        await this.track(tree.treeRoot);
        await checkpointJournal.appendExecution(tree.treeRoot, {
          version: 1,
          kind: 'active',
          tree: tree.treeRoot,
          owner: context.owner,
          runtime: context.runtime,
          turn: context.turn,
          start: this.execution.start
        });
      }
      if (!baseline) return;
      const snap = await checkpointGit.capture(tree, this.owner);
      if (snap) {
        this.baseline = { tree, snap };
      }
    });
  }

  closeExecution(
    cwd: string,
    observation?: (
      store: checkpointModel.ExecutionStore,
      turn: string
    ) => Promise<{ observed: boolean; calls: readonly checkpointModel.ExecutionCall[] }>
  ): Promise<{ ck?: checkpointModel.TurnCheckpoint; ex?: checkpointModel.ExecutionCoverage }> {
    const detached = this.serialise(() => {
      const current = this.execution;
      this.execution = undefined;
      return Promise.resolve(current);
    });
    const taken = this.close(cwd);
    return taken.then(async (ck) => {
      const current = await detached;
      if (!current) return ck ? { ck } : {};
      const store = await checkpointJournal.readExecution(current.tree);
      const observed = observation
        ? await observation(store, current.turn).catch(() => ({ observed: false, calls: [] }))
        : { observed: false, calls: [] };
      const end = Date.now();
      const ex = await checkpointExecution.selectExecution(
        {
          ...current,
          end,
          observed: current.observed && store.readable && observed.observed,
          calls: observed.calls,
          ...(ck ? { floor: ck } : {})
        },
        store.edges
      );
      await checkpointJournal.appendExecution(current.tree, ex);
      await checkpointExecution.endUnpaired(current, store, observed, end);
      // A call run from another cwd published to that tree, and would hold it uncertain until exit.
      for (const root of await this.registeredTrees(current.runtime))
        if (root !== current.tree)
          await checkpointExecution.endUnpaired(
            current,
            await checkpointJournal.readExecution(root),
            observed,
            end
          );
      return { ...(ck ? { ck } : {}), ex };
    });
  }

  async endExecution(runtime: string, contextFile?: string): Promise<void> {
    await this.serialise(() =>
      checkpointExecution.endRuntime(runtime, contextFile, this.executionTrees, false)
    );
    this.end();
    await this.flush();
    // The directory stays for core/prune.ts; a late hook finds the journal's runtime-end.
  }

  private async registeredTrees(runtime: string): Promise<Set<string>> {
    const roots = new Set(this.executionTrees);
    if (this.journal)
      for (const root of await checkpointJournal.readRuntimeTrees(this.journal, runtime))
        roots.add(root);
    return roots;
  }

  private async track(treeRoot: string): Promise<void> {
    if (this.executionTrees.has(treeRoot)) return;
    this.executionTrees.add(treeRoot);
    if (!this.journal) return;
    try {
      await checkpointJournal.appendRuntimeNote(this.journal, treeRoot);
    } catch {
      /* In-memory tracking still bounds the row on an orderly end. */
    }
  }

  /**
   * The other end: what this turn did, or nothing.
   *
   * **The baseline is consumed either way.** Not every idle edge follows an
   * `open` — `init` opens a turn, and so do auto-compaction, a `/clear` and a
   * resumed queue — and any of those would otherwise diff against the previous
   * turn's baseline and hand this turn the gap before it. "No baseline" is a
   * silent skip, not an error.
   *
   * **The tree is pinned to the baseline and re-read here.** A session that
   * stepped from `/repo` into `/repo/.worktrees/feat` mid-turn would close in a
   * different checkout, and two linked worktrees of one repository *share an
   * object store* — so the diff would succeed and report every file that
   * differs between two checkouts. An unrelated repository fails safe on the
   * missing object alone; this one does not, and it is the case the live
   * tenancy key was introduced for.
   */
  async close(cwd: string): Promise<checkpointModel.TurnCheckpoint | undefined> {
    return this.serialise(async () => {
      const base = this.baseline;
      this.baseline = undefined;
      if (!base) {
        return undefined;
      }
      const live = await readTree(cwd);
      if (live?.treeRoot !== base.tree.treeRoot) {
        return undefined;
      }
      const to = await checkpointGit.capture(base.tree, this.owner);
      if (!to) {
        return undefined;
      }
      const changes = await checkpointGit.changesBetween(base.tree, base.snap.tree, to.tree);
      if (!changes) {
        return undefined;
      }
      // Only where both ends have a sha to compare. One end without one is
      // *cannot say*, which `moves` absent already means and which rule 3
      // withholds on — asking the reflog about it would answer the same thing
      // more slowly.
      const moves =
        base.snap.head !== undefined && to.head !== undefined
          ? await checkpointGit.headMoves(base.tree, base.snap.head, to.head)
          : undefined;
      const aliases = treeAliases(base.tree.treeRoot).filter((root) => root !== base.tree.treeRoot);
      return {
        tree: base.tree.treeRoot,
        ...(aliases.length ? { aliases } : {}),
        from: base.snap,
        to,
        changes,
        ...(moves === undefined ? {} : { moves })
      };
    });
  }

  /**
   * Forget this turn's baseline without diffing against it.
   *
   * For a caller that took one and then never released a turn against it: the
   * outbox was emptied inside the window, or a turn the caller did not start
   * began there. Left on the object, that snapshot is what the **next** idle
   * edge would diff — and it would report a window its turn never started in,
   * which is rule 1's own failure mode arriving one await later.
   *
   * `close` would clear it too, at the price of a capture whose answer is
   * thrown away. `end` would clear it as well and also drop the warm index,
   * which costs the next real turn a cold capture (566ms against 43ms) for a
   * session that is not ending. This does neither.
   *
   * On the chain, so it cannot land between a `close` already queued and the
   * baseline that `close` is owed.
   */
  discard(): void {
    void this.serialise(async () => {
      this.baseline = undefined;
      const current = this.execution;
      this.execution = undefined;
      if (current)
        await checkpointJournal.appendExecution(current.tree, {
          version: 1,
          kind: 'coverage',
          tree: current.tree,
          owner: current.owner,
          runtime: current.runtime,
          turn: current.turn,
          start: current.start,
          end: Date.now(),
          source: 'execution',
          windows: [],
          calls: []
        });
    });
  }

  /**
   * End on the chain so a turn ending just before its session keeps its diff.
   * A mid-turn child exit reaches both edges in one frame: clearing the baseline
   * before the queued `close` would drop that turn's pills.
   */
  end(): void {
    void this.serialise(async () => {
      const tree = this.seen;
      this.baseline = undefined;
      this.seen = undefined;
      if (tree) {
        await checkpointGit.forgetIndex(tree, this.owner);
      }
    });
  }

  /**
   * One capture at a time for this owner, and never a rejection: the chain has
   * to survive to carry the next boundary, and nothing awaits it from a place
   * that could report a failure anyway.
   */
  async flush(): Promise<void> {
    let current: Promise<unknown>;
    do {
      current = this.chain;
      await current;
    } while (current !== this.chain);
  }

  private serialise<T>(work: () => Promise<T>): Promise<T | undefined> {
    const done = this.chain.then(work).catch(() => undefined);
    this.chain = done;
    return done;
  }
}
