import type { Written } from './transcript';

/**
 * One working tree at one instant.
 *
 * `head` is carried because the caller has to know whether HEAD *moved* across
 * the pair: a turn that runs `checkout`, `merge`, `rebase` or `reset --hard`
 * rewrites the tree by every file that differs between two commits, with no
 * neighbour involved and nothing for an overlap test to catch. Absent where the
 * repository has no commit yet, which is not the same as unchanged — a caller
 * comparing two snapshots must treat an absent `head` as "cannot say".
 *
 * `op` names a git operation the tree was in the middle of, and is the half of
 * that test a sha cannot make. A **conflicted** merge, rebase or cherry-pick
 * stops *before* committing, so HEAD has not moved and the sha reads as
 * unchanged — while the tree now holds every file the operation touched, with
 * conflict markers in them. Verified 2026-08-22: `git merge` into a conflict
 * leaves HEAD exactly where it was.
 */
export type Snapshot = { tree: string; head?: string; at: number; startedAt?: number; op?: string };

export function executionMasterKey(
  call: Pick<ExecutionBoundary, 'tree' | 'owner' | 'runtime'>
): string {
  return JSON.stringify(['execution-master', call.owner, call.runtime, call.tree]);
}

/**
 * Match `Authored`: `files` holds every path in order, while `sizes` contains
 * counts only where readable. Downstream merges assert `Object.keys(sizes) ⊆ files`.
 */
export type TurnChanges = { files: string[]; sizes: Record<string, Written> };

/**
 * One turn's claim on a working tree: who, when, and what it changed.
 *
 * Deliberately thinner than the record's own copy — no counts, no HEAD, no
 * operation — because a neighbour reading this needs only *which paths were
 * contested*, and the file is read whole on every poll while a dock is open.
 *
 * `sid` is an owner key (`conversationKey`) on new rows and a bare session id
 * on legacy rows. A `/clear` changes the session id in either, so a cleared
 * session is a different conversation on the same tree and its earlier windows
 * stay somebody else's.
 */
export type TurnWindow = {
  sid: string;
  start: number;
  end: number;
  paths: string[];
  uncertain?: true;
  unavailable?: true;
};

export type ExecutionBoundary = {
  version: 1;
  kind: 'execution';
  tree: string;
  owner: string;
  runtime: string;
  actor: string;
  call: string;
  context?: string;
  edge: 'before' | 'after';
  start: number;
  end: number;
  snapshot?: Snapshot;
  pending?: true;
  task?: string;
};

export type ExecutionCall = {
  actor: string;
  call: string;
  context?: string;
  eligibility: 'write' | 'read' | 'delegate' | 'unknown';
  settled: boolean;
};

export type ExecutionTurn = {
  owner: string;
  runtime: string;
  turn: string;
  tree: string;
  start: number;
  end: number;
  observed: boolean;
  calls: readonly ExecutionCall[];
  floor?: TurnCheckpoint;
};

export type ExecutionCoverage = {
  version: 1;
  kind: 'coverage';
  owner: string;
  runtime: string;
  turn: string;
  tree: string;
  start: number;
  end: number;
  source: 'execution' | 'turn' | 'none';
  windows: readonly TurnCheckpoint[];
  calls: readonly { actor: string; call: string }[];
  floor?: TurnCheckpoint;
};

export type ExecutionActive = {
  version: 1;
  kind: 'active';
  tree: string;
  owner: string;
  runtime: string;
  turn: string;
  start: number;
};

export type ExecutionEnd = {
  version: 1;
  kind: 'runtime-end';
  tree: string;
  runtime: string;
  at: number;
};

export type ExecutionCallEnd = {
  version: 1;
  kind: 'call-end';
  tree: string;
  owner: string;
  runtime: string;
  actor: string;
  call: string;
  at: number;
};

export type ExecutionEvidence =
  ExecutionBoundary | ExecutionCoverage | ExecutionActive | ExecutionEnd | ExecutionCallEnd;

export type ExecutionStore = {
  readable: boolean;
  edges: readonly ExecutionBoundary[];
  coverage: readonly ExecutionCoverage[];
  active: readonly ExecutionActive[];
  ended: readonly ExecutionEnd[];
  callEnds: readonly ExecutionCallEnd[];
  windows: TurnWindow[];
};

export type ExecutionRequest = Pick<
  ExecutionBoundary,
  'owner' | 'runtime' | 'actor' | 'call' | 'context' | 'edge' | 'pending' | 'task'
> & { cwd: string };

export function callKey(call: Pick<ExecutionCall, 'actor' | 'call'>): string {
  return JSON.stringify([call.actor, call.call]);
}

export function executionKey(
  edge: Pick<ExecutionBoundary, 'owner' | 'runtime' | 'actor' | 'call' | 'tree'>
): string {
  return JSON.stringify([edge.owner, edge.runtime, edge.actor, edge.call, edge.tree]);
}

/**
 * One turn's checkpoint, as its own record keeps it — the raw reading, before
 * any gate has run on it.
 *
 * Raw on purpose. The verdict below depends on what *neighbours* did, and a
 * neighbour still mid-turn has not written its window yet — so a verdict frozen
 * at capture time would be stale for exactly the case it exists to catch. What
 * is written down is what this session observed; what is drawn is recomputed on
 * every read and self-corrects as neighbours finish.
 *
 * `from.at` and `to.at` are the window, so there is no second copy of it to
 * disagree with.
 */
export type TurnCheckpoint = {
  tree: string;
  aliases?: readonly string[];
  from: Snapshot;
  to: Snapshot;
  changes: TurnChanges;
  /**
   * What HEAD did across the turn, from `headMoves`, taken at the end capture
   * because a reflog moves on. Absent means *cannot say* — including the case
   * where HEAD did not move, which `headMoves` reports as an empty list, so the
   * two are never confused.
   */
  moves?: string[];
};

/**
 * What a turn may actually claim.
 *
 * `concurrent` says **a path was taken out of this list**, not "a neighbour was
 * awake". The difference is the whole value of the flag, and the numbers decide
 * it: a marker on any overlap fires on 67.1% of writer turns machine-wide and
 * 85.6% on this repo's own checkout, which is wallpaper — a reader stops seeing
 * it in a day, and it names nothing to do. A marker on a *subtraction* fires on
 * roughly one writer turn in sixteen and says something worth reading: there was
 * more here and it could not honestly be claimed.
 *
 * It is therefore never set by rule 3, which withholds for a reason that has
 * nothing to do with a neighbour.
 */
export type Attributed = TurnChanges & { concurrent?: true };
