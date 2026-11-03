/**
 * Which turns a settled exchange folds away, so a long run reads as one line.
 *
 * Ported as a concept from t3code's
 * `apps/web/src/components/chat/MessagesTimeline.logic.ts:250-404`
 * (`deriveTurnFolds`, MIT — see `ui/activity.ts` for the attribution this
 * shares). Theirs groups by a server-assigned `turnId`, which is a thing a live
 * driver has and a transcript reader does not: here the boundary is the reader's
 * own prompt, or the trigger marker of a turn the CLI started by itself —
 * the only marks in the file that say a turn began.
 *
 * What a fold hides is the machinery and nothing else: the turns that ran
 * something and said nothing about it. Every turn that wrote prose stands,
 * wherever in the run it landed — a paragraph is the reader's, and a row
 * reading "Worked for 48s" over one is the panel deciding it was not worth
 * reading. The reader can open a fold, and the dock owns the words on the row
 * it leaves behind.
 */
import { addWritten, type Written } from '../core/transcript';

/**
 * One fold: the exchanges it hides, and how long that work took.
 *
 * One per run of work rather than one per turn, because prose stands: a turn
 * that spoke, ran something, spoke again and ran something else has two runs
 * with a paragraph between them, and one row cannot stand in two places. A row
 * that tried would swallow the second run with nothing left on screen to say it
 * happened — which is what a single row per turn did until the rule changed.
 *
 * Indices rather than a range even so, and that is measured rather than tidy:
 * 28 of 182 groups on this machine (2026-07-29) hold a marker somewhere other
 * than their first or last slot, and a marker never folds — a skill chip and an
 * interrupt are the two things a reader most wants out of a long run. A skill
 * chip or a break is transparent rather than a boundary: it leaves a hole in
 * the hidden set and does not split the run around it, since the work either
 * side of a skill chip is still one run of work. A trigger is the exception: it
 * starts a turn, so `groupsIn` splits there.
 */
export interface Fold {
  /** Where the row stands: the first exchange it hides. */
  at: number;
  /** Every index it hides, `at` included, ascending. */
  hides: number[];
  /** How long this run of work took, in ms — measured between the turns
   *  standing either side of it. Absent when neither end is stamped. */
  ms?: number;
  /** The turn ended in an interrupt, so the row says who ended it. */
  stopped?: boolean;
  /** What the hidden turns wrote, deduped, in first-write order. A write turn
   *  carries no prose and so is exactly what a fold hides: without this,
   *  folding a turn takes its file pills with it. A turn that spoke is not
   *  hidden at all, and draws its own. */
  files?: string[];
  /** How much of each of those files the run wrote, summed across the hidden
   *  turns by `core/transcript.ts`'s `addWritten`, which is where the two merge
   *  rules are. Keys stay a subset of `files`. */
  sizes?: Record<string, Written>;
  /** Common turn baseline of the hidden exchanges, when one can be stated. */
  base?: string;
  /** One of the hidden turns had a path left out of its own list — see
   *  `AuthoredView.concurrent`. Without this a fold hiding a marked turn would
   *  drop the marker silently, which is the one reading a short list must never
   *  be given. */
  concurrent?: true;
  /** The same fold across polls, so one a reader opened stays open. The
   *  anchor's own stamp, which the CLI writes on every entry; a turn without
   *  one falls back to its position, and an open fold there closes when the
   *  thread grows. */
  key: string;
}

/** A run of exchanges between two prompts: what the session did about one. A
 *  trigger stands as the prompt of the turn it explains. */
type Group = { prompt?: number; start: number; end: number };

/**
 * The folds for a thread, in the order the rows stand.
 *
 * `running` is the newest group's alone: a turn still being written must never
 * fold, or the thread would collapse under the reader mid-answer and reopen
 * when it finished. Everything older is settled by definition — a prompt after
 * it is proof the turn ended.
 */
export function folds(exchanges: readonly ExchangeView[], running: boolean): Fold[] {
  const out: Fold[] = [];
  const groups = groupsIn(exchanges);
  for (const [i, group] of groups.entries()) {
    if (running && i === groups.length - 1) {
      continue;
    }
    out.push(...foldsOf(exchanges, group));
  }
  return out;
}

/**
 * The groups, one per prompt. A thread that opens mid-conversation starts in a
 * group with no prompt of its own, which is the one case a duration has to be
 * measured from the work rather than from the asking.
 */
function groupsIn(exchanges: readonly ExchangeView[]): Group[] {
  const groups: Group[] = [];
  let prompt: number | undefined;
  let start = -1;
  const close = (end: number): void => {
    if (start >= 0) {
      groups.push({ prompt, start, end });
      start = -1;
    }
  };
  for (let i = 0; i < exchanges.length; i++) {
    const x = exchanges[i];
    if (!x) {
      continue;
    }
    if (('mark' in x && x.mark === 'trigger') || (!('mark' in x) && x.role === 'user')) {
      close(i);
      prompt = i;
      continue;
    }
    if (start < 0) {
      start = i;
    }
  }
  close(exchanges.length);
  return groups;
}

/**
 * A group's folds: one per run of work, in the order the rows stand.
 *
 * What the session said stays, whenever it said it; what it did goes behind a
 * row. Prose is prose wherever in the turn it landed — a paragraph the model
 * wrote before a run of calls is as much an answer as the one after — so a
 * turn that spoke twice ends the first run and opens the second.
 */
function foldsOf(exchanges: readonly ExchangeView[], group: Group): Fold[] {
  let stopped = false;
  const authored: number[] = [];
  const stands: number[] = [];
  const runs: number[][] = [];
  let run: number[] | undefined;
  for (let i = group.start; i < group.end; i++) {
    const x = exchanges[i];
    if (!x) {
      continue;
    }
    // Transparent: a marker neither folds nor ends the run around it.
    if ('mark' in x) {
      stopped ||= x.mark === 'break';
      continue;
    }
    authored.push(i);
    // Wordless and pictureless. `transcript.ts` refuses to merge an image-only
    // turn away for the reason a fold must refuse to hide one: folding it takes
    // the picture with it, and a picture is not machinery.
    //
    // An answered question is the same case. The turn that makes the call
    // usually writes no prose, so every ask but the newest folded away behind
    // "Worked for 2m" — and the ask a reader wants to reopen is exactly an old
    // one. A question somebody answered is not machinery either.
    if (!x.text && !x.images?.length && !asked(x) && x.maintenance !== true) {
      if (!run) {
        run = [];
        runs.push(run);
      }
      run.push(i);
      continue;
    }
    stands.push(i);
    run = undefined;
  }
  // No runs, no rows: a turn that answered and did nothing else is already one
  // line, and a row saying "Worked for 2s" over it would be the longer reading.
  const out: Fold[] = [];
  for (const [k, hides] of runs.entries()) {
    const at = hides[0];
    if (at === undefined) {
      continue;
    }
    const files = wrote(exchanges, hides);
    const sizes = written(exchanges, hides);
    const base = commonBase(exchanges, hides);
    const short = hides.some((i) => {
      const x = exchanges[i];
      return !!x && !('mark' in x) && x.concurrent === true;
    });
    out.push({
      at,
      hides,
      ...(elapsed(exchanges, group, stands, authored, hides) ?? {}),
      // The interrupt ended the group, so it belongs to the last run in it —
      // the only one that could have been what the reader cut short.
      ...(stopped && k === runs.length - 1 ? { stopped: true } : {}),
      ...(files.length ? { files } : {}),
      ...(Object.keys(sizes).length ? { sizes } : {}),
      ...(base !== undefined ? { base } : {}),
      ...(short ? { concurrent: true as const } : {}),
      key: `f|${stampOf(exchanges[at]) ?? `at${at}`}`
    });
  }
  return out;
}

function commonBase(
  exchanges: readonly ExchangeView[],
  hides: readonly number[]
): string | undefined {
  let base: string | undefined;
  for (const i of hides) {
    const exchange = exchanges[i];
    if (!exchange || 'mark' in exchange || exchange.base === undefined) continue;
    if (base !== undefined && base !== exchange.base) return undefined;
    base = exchange.base;
  }
  return base;
}

/** Whether a turn carries a question somebody answered, which a run may not
 *  hide. `blocks` is the same list the dock draws the pills off. */
function asked(x: AuthoredView): boolean {
  return (x.blocks ?? []).some((b) => 'ask' in b && b.ask !== undefined);
}

/**
 * How much the hidden turns wrote, summed per file.
 *
 * The sibling of `wrote` and deliberately not folded into it: the two merge the
 * same key by different rules, and `addWritten` is this one. Only files `wrote`
 * returned can appear here, which is the invariant `fold.test.ts` asserts.
 */
function written(
  exchanges: readonly ExchangeView[],
  hides: readonly number[]
): Record<string, Written> {
  const sizes: Record<string, Written> = {};
  for (const i of hides) {
    const x = exchanges[i];
    if (!x || 'mark' in x) {
      continue;
    }
    for (const [file, more] of Object.entries(x.sizes ?? {})) {
      addWritten(sizes, file, more);
    }
  }
  return sizes;
}

/**
 * What the hidden turns wrote, deduped across them, in first-write order.
 *
 * Deduped across the whole fold and not merely within a turn: a run that edits
 * one file eight times is eight turns naming it, and eight identical pills on
 * one row would say the file was written eight places rather than eight times.
 * The count belongs to the "18 steps" the row already prints.
 */
function wrote(exchanges: readonly ExchangeView[], hides: readonly number[]): string[] {
  const files: string[] = [];
  for (const i of hides) {
    const x = exchanges[i];
    if (!x || 'mark' in x) {
      continue;
    }
    for (const file of x.files ?? []) {
      if (!files.includes(file)) {
        files.push(file);
      }
    }
  }
  return files;
}

/**
 * How long one run of work took: between the turns standing either side of it.
 *
 * The row sits in a gap, and its duration is that gap — from the last thing the
 * reader can see above it to the first they can see below. For the ordinary
 * turn, that is prompt to answer and reads exactly as it did when a group had
 * one row: measured from the **prompt**, not from the first reply, because the
 * first reply only appears once the model has started producing, which is
 * exactly the wait a reader is asking about. For a run in the middle of a turn,
 * it is paragraph to paragraph — the wait between two things they read.
 *
 * Each fallback is a bound the thread does not have: no turn standing above
 * means the prompt, no prompt either (the thread opened mid-turn) means the
 * run's own first stamp, which undercounts and says so by being the only
 * reading available. Nothing standing below means the group's last turn, which
 * for a trailing run is that run's own end.
 *
 * The CLI's stamps are when the *model* wrote each block rather than when the
 * line reached disk (`docs/reference/cli_state/claude/transcript.md`), so this is the work
 * and not the file's own lag.
 */
function elapsed(
  exchanges: readonly ExchangeView[],
  group: Group,
  stands: readonly number[],
  authored: readonly number[],
  hides: readonly number[]
): { ms: number } | undefined {
  const first = hides[0];
  const last = hides.at(-1);
  if (first === undefined || last === undefined) {
    return undefined;
  }
  const above = stands.filter((i) => i < first).at(-1);
  const below = stands.find((i) => i > last);
  const from = stampOf(nth(exchanges, above ?? group.prompt)) ?? stampOf(nth(exchanges, first));
  const to = stampOf(nth(exchanges, below ?? authored.at(-1)));
  if (from === undefined || to === undefined || to < from) {
    return undefined;
  }
  return { ms: to - from };
}

/**
 * The exchange an index names, when there is an index.
 *
 * A group that authored nothing has no first and no last, and this is where
 * that is said. It used to be said by `exchanges[authored[0] ?? -1]` — a
 * sentinel that works because `noUncheckedIndexedAccess` hands back `undefined`
 * for a negative index, which is a compiler flag doing the reasoning the code
 * was meant to state.
 */
function nth(exchanges: readonly ExchangeView[], i: number | undefined): ExchangeView | undefined {
  return i === undefined ? undefined : exchanges[i];
}

/** A turn's stamp, or a trigger's — the one marker that carries a time. */
const stampOf = (x: ExchangeView | undefined): number | undefined => x?.at;
