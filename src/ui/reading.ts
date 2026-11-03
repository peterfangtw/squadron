/**
 * What a card says, and which nav count and hue that puts it under. The host
 * resolves it (`resolve`, from `toCard`) and ships the answer on `CardView`;
 * card and nav pick between the two answers it ships (`reading`). A leaf: the
 * nav used to import it off `board_card`, which is the cycle the module map
 * names.
 */

import type { TurnOutcome } from '../core/events';

/**
 * What a session's step list says: which of the two readings it is, and the
 * word a card wears for it — or nothing when it has no list to speak from,
 * which is most cards and every background one.
 *
 * `done` says the session is finished and needs nobody. `stalled` is the one
 * worth reading: steps left and nothing running, which is work sitting still
 * that no other state on the board would have shown.
 *
 * `kind` rides beside the word because the word is not safe to read back. The
 * card's hue and the nav bar's count both need to know which reading this is,
 * and the only other way to ask is to sniff the string they were handed — in a
 * slot the CLI's own free text (`waitingFor`) can also fill, so a session that
 * wrote "done" there would have been counted as finished. `ui/text.ts` states
 * the rule this keeps: bucket on what a field means, never on text another
 * program wrote.
 *
 * Whether a list may speak at all is `stepList`'s question, asked first.
 */
export const progress = (
  done: { total: number; completed: number } | undefined
): { kind: 'done' | 'stalled'; word: string } | undefined =>
  !done
    ? undefined
    : done.completed >= done.total
      ? { kind: 'done', word: 'done' }
      : { kind: 'stalled', word: 'stalled' };

/**
 * What a session states that a card reads: the facts, not yet ranked. Nothing
 * here is gated — whether each may speak is `resolve`'s decision.
 */
export interface CardFacts {
  status: SessionStatusView;
  /** The CLI's own free text for what it is blocked on. */
  waitingFor?: string;
  completion?: { total: number; completed: number };
  /** It replied after the reader last opened it (`ui/views.ts` dates both). */
  unseen: boolean;
  neverSeen: boolean;
  turnOutcome?: TurnOutcome;
}

/**
 * What a card says it is, and which count and hue that puts it under — the one
 * place that decides which facets may speak and how they rank, so the pill,
 * the hue and the count cannot disagree. A count that bucketed on `status`
 * while the cards read off `word` said "7 idle" over a board showing three
 * green DONE cards, and the pick behind it took a reader to a view they had
 * not asked for.
 *
 * The rank: what a session is blocked on beats a turn that could not run, which
 * beats what it stopped short of, which beats what it delivered. `failed` is
 * the CLI's own statement about the last turn (`core/live.ts` keeps it until
 * the next one begins), so it outranks a step list the failure left
 * unfinished, and opening the card does not clear it — looking at a turn that
 * did not run does not make it run.
 *
 * Every facet but the waiting word is a reading of `idle`: a busy session is
 * mid-step by definition, and `stalled` on a card working right now
 * would be the panel contradicting itself.
 *
 * `unread` is the generic `done`, and last because it is the weakest claim: it
 * says only that nobody has looked, where the others say what the session
 * itself is doing. `stalled` outranking it is deliberate — steps left is more
 * worth finding than output unread. It is shipped beside the base reading, not
 * folded into it, so a deliberate acknowledgement can retire it.
 *
 * A waiting card's `tally` stays its status: the word is free text from the
 * CLI (`permission prompt`, whatever a hook wrote), which cannot be a bucket,
 * and a session that wrote `done` into it would otherwise have left the
 * `waiting` count and hidden itself from a reader filtering for what waits.
 * `ui/text.ts` states the rule: bucket on what a field means, never on text
 * another program wrote.
 */
export function resolve(f: CardFacts): Pick<CardView, 'reading' | 'unread' | 'attention'> {
  const spoke = facet(f);
  const base = spoke ?? { word: f.status, tally: f.status };
  if (['waiting', 'stalled', 'failed'].includes(base.tally) && (f.unseen || f.neverSeen))
    return { reading: base, attention: true };
  return !spoke && f.status === 'idle' && f.unseen
    ? { reading: base, unread: { word: 'done', tally: 'done' } }
    : { reading: base };
}

/** The facet that outranks `unread`, if one spoke, highest first. */
function facet(f: CardFacts): CardReading | undefined {
  if (f.waitingFor) return { word: f.waitingFor, tally: f.status };
  if (f.status === 'idle' && f.turnOutcome === 'error') return { word: 'failed', tally: 'failed' };
  const steps = progress(stepList(f));
  return steps && { word: steps.word, tally: steps.kind };
}

/**
 * The step list, when it may speak: idle only, since a list is a statement
 * about work that has stopped. Exported for the count `CardView.completion`
 * carries to `squadron-list` — which prints it beside the status and no turn
 * outcome, so a failed card with steps left lists as idle with a count
 * (the task file's "Left as it is").
 */
export const stepList = (f: Pick<CardFacts, 'status' | 'completion'>): CardFacts['completion'] =>
  f.status === 'idle' ? f.completion : undefined;

/**
 * Unread stays visible until a deliberate acknowledgement. Selection alone
 * cannot prove a reply was seen: it can arrive after the selecting click.
 */
export const reading = (s: CardView): CardReading => s.unread ?? s.reading;
