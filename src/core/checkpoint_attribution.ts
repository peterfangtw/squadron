import { fileIdentity } from './git';
import type { Written } from './transcript';
import * as checkpointModel from './checkpoint_model';

/** Whether a HEAD move left the working tree alone. Only a commit does, in its
 *  three spellings; every other action git writes here rewrote files. */
function isCommit(action: string): boolean {
  return /^commit\b/.test(action);
}

export function attributeExecution(
  coverage: checkpointModel.ExecutionCoverage,
  windows: readonly checkpointModel.TurnWindow[]
): checkpointModel.Attributed {
  const claims = new Map<
    string,
    { path: string; intervals: { start: number; end: number; size?: Written }[] }
  >();
  let concurrent = false;
  for (const interval of coverage.windows) {
    const accepted = attribute(interval, coverage.owner, windows);
    concurrent ||= accepted.concurrent === true;
    for (const file of accepted.files) {
      const key = fileIdentity(interval.tree, file, interval.aliases);
      let claim = claims.get(key);
      if (!claim) {
        claim = { path: file, intervals: [] };
        claims.set(key, claim);
      }
      claim.intervals.push({
        start: interval.from.startedAt ?? interval.from.at,
        end: interval.to.at,
        ...(accepted.sizes[file] ? { size: accepted.sizes[file] } : {})
      });
    }
  }
  const sizes: Record<string, Written> = {};
  for (const claim of claims.values()) {
    const intervals = claim.intervals.sort((a, b) => a.start - b.start);
    if (
      intervals.some(
        (interval, i) =>
          !interval.size || (i > 0 && interval.start < (intervals[i - 1]?.end ?? Infinity))
      )
    )
      continue;
    sizes[claim.path] = intervals.reduce(
      (sum, interval) => ({
        add: sum.add + (interval.size?.add ?? 0),
        del: sum.del + (interval.size?.del ?? 0)
      }),
      { add: 0, del: 0 }
    );
  }
  return {
    files: [...claims.values()].map((claim) => claim.path),
    sizes,
    ...(concurrent ? { concurrent: true } : {})
  };
}

function silent(): checkpointModel.Attributed {
  return { files: [], sizes: {} };
}

/**
 * Rule 3: was this tree rewritten by something that is not a write?
 *
 * A `checkout`, `reset --hard`, `merge` or `rebase` changes the tree by every
 * file that differs between two commits, with one writer and no overlap — so the
 * concurrency gate never fires and the turn claims hundreds of files it did not
 * author. Sole-tenant false pills at the scale path B was killed for.
 *
 * Three tests, and each catches what the others cannot:
 *
 * - **`op`**, from the marker files git leaves mid-operation. A *conflicted*
 *   merge, rebase or cherry-pick stops before committing, so HEAD never moves at
 *   all and no sha or reflog test can see it — while the tree now holds every
 *   file the operation touched.
 * - **The reflog**, where HEAD did move. This is what keeps the feature useful:
 *   18.9% of writer turns on this machine run `git commit`, which touches no
 *   working-tree file, against 3.9% that move HEAD by anything else. Withholding
 *   on the sha alone would go silent on one turn in five, and on exactly the
 *   turns that finished something.
 * - **A HEAD move the reflog cannot account for** — expired, disabled, or a
 *   chain that does not reach back. Unexplained is withheld, never waved
 *   through.
 *
 * What none of them catches is a rewrite that moves neither HEAD nor a marker:
 * `git restore .`, `git checkout -- <path>`, `git stash pop` where it does not
 * conflict. Named blind spots, and they are the same class as the reader's own
 * editor edit.
 */
function rewritten(mine: checkpointModel.TurnCheckpoint): boolean {
  if (mine.from.op !== undefined || mine.to.op !== undefined) {
    return true;
  }
  if (mine.from.head === mine.to.head) {
    return false;
  }
  return mine.moves === undefined || !mine.moves.every(isCommit);
}

/**
 * What this turn may say it wrote, given what else was happening in the tree.
 *
 * Two questions, answered separately because they are separate — and the
 * findings doc's rule 2 conflated them until the numbers came in. **Was the
 * window contested** decides the marker; **which files were contested** decides
 * the pills. Measured over 2,154 transcripts: 67.1% of writer turns overlap
 * another writer's turn on the same tree, but among overlapped turns that named
 * files, 91% collided with a neighbour on *no file at all*. Withholding the
 * whole turn on overlap would therefore have gone silent two turns in three to
 * protect against something that happens in one turn in fifty.
 *
 * So a contested path is **omitted**, never marked. That is the findings doc's
 * own principle — *a missing pill beats one naming a file never written* — and
 * a badge does not unmake the sentence a pill makes. What the marker says is
 * the thing that is true of the window rather than of any file in it: somebody
 * else was writing here, so this list may be short.
 *
 * The evidence exists because rule 4 confines the scheme to owned sessions and
 * we checkpoint every one of them on this tree — so an overlapping neighbour's
 * account of itself is already on disk, and it names what it touched however it
 * touched it, `sed` and heredocs included.
 *
 * **Two inferences are forbidden here and must stay forbidden**, both from the
 * findings doc's *What the gate is made of*: "my frames name no such file, so it
 * is not mine", and its mirror for a neighbour. A shell write names no file, so
 * either would throw away precisely the writes this module exists to recover.
 * Nothing below reads a frame.
 *
 * What it cannot see is stated rather than guessed at: a session with no
 * checkpoint chain — one somebody typed `claude` for, a watcher, the reader's
 * own edit in the editor — leaves no window here and is invisible to both
 * questions. Named blind spots, not handled cases.
 */
export function attribute(
  mine: checkpointModel.TurnCheckpoint,
  sid: string,
  windows: readonly checkpointModel.TurnWindow[],
  legacySid?: string
): checkpointModel.Attributed {
  if (rewritten(mine)) {
    return silent();
  }

  const start = mine.from.startedAt ?? mine.from.at;
  const end = mine.to.at;
  const contested = new Set<string>();
  for (const window of windows) {
    if (window.unavailable) return silent();
    // A turn cannot contest itself, and a turn that merely abutted mine wrote
    // nothing inside it — so the comparison is strict at both ends. A legacy
    // row names its owner by bare session id; it is this turn's own only when
    // its interval is exactly this checkpoint's, which no other brand's can be.
    if (
      window.sid === sid ||
      (legacySid !== undefined &&
        window.sid === legacySid &&
        window.start === start &&
        window.end === end) ||
      window.start >= end ||
      window.end <= start
    ) {
      continue;
    }
    if (window.uncertain)
      return mine.changes.files.length ? { ...silent(), concurrent: true } : mine.changes;
    for (const at of window.paths) {
      contested.add(fileIdentity(mine.tree, at, mine.aliases));
    }
  }
  if (!contested.size) {
    return mine.changes;
  }

  const files = mine.changes.files.filter(
    (at) => !contested.has(fileIdentity(mine.tree, at, mine.aliases))
  );
  if (files.length === mine.changes.files.length) {
    // See attribute for the 91% no-collision measurement, and
    // Attributed.concurrent for why a complete list gets no marker.
    return mine.changes;
  }
  const sizes: Record<string, Written> = {};
  for (const at of files) {
    const size = mine.changes.sizes[at];
    if (size) {
      sizes[at] = size;
    }
  }
  return { files, sizes, concurrent: true };
}
