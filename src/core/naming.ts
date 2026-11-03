/**
 * Which of several names a card wears, and what kind of claim each one is.
 *
 * One ordering, two callers. `core/live.ts` chooses between the strings an
 * owned session's own pipe holds; `ui/views.ts` chooses between what that half
 * already settled on and what a file on disk says. They answered the same
 * question separately until this module existed, and had already drifted:
 * `live.ts` could tell a generated title from a name given at the spawn and
 * `views.ts` could not — it collapsed the two into "not `derived`" — so a
 * `--name` in the session file overwrote a title the round trip had just
 * produced, and the card renamed itself back on the next poll.
 *
 * **`nameSource` on the wire stays the loose string it was.** It carries the
 * CLI's own word (`derived`, `user`) beside ours, from three brands and two
 * readers, and this is the one place that reads either. Nothing downstream
 * matches on it but `displayName`, which asks the single question this module
 * cannot answer for it: whether the name is the directory over again.
 */

/**
 * Every kind of claim a name can be, best first.
 *
 * 1. **stated** — what a person or an agent said this conversation is called
 *    (`core/names.ts`). Above everything because it is the only rung nobody
 *    guessed, and because a brand may have no way of being told it at all.
 * 2. **given** — somebody told the CLI: a `--name` at the spawn, a `/rename`
 *    in its own UI. A statement too, but one made to the CLI rather than to us,
 *    so a store entry outranks it.
 * 3. **generated** — the CLI's own title. Claude answers a
 *    `generate_session_title` round trip, Codex pushes `thread/name/updated`,
 *    Grok writes one into its chrome. A guess, and still the name that a card
 *    nobody ever renames ends up wearing.
 * 4. **prompt** — the first line of what the session was spawned with, cut by
 *    `sessionName`. Ours, and a placeholder: it says what the work is before
 *    any CLI has had a turn to say it better. Below the guess deliberately —
 *    the whole point is that the title replaces it.
 * 5. **derived** — the directory plus a suffix, which says nothing the group
 *    heading does not already say. The bottom, and what `displayName` folds.
 */
const RUNGS = ['stated', 'given', 'generated', 'prompt', 'derived'] as const;

export type NameRung = (typeof RUNGS)[number];

/**
 * One candidate name, and the kind of claim behind it.
 *
 * `name` is optional because every caller has a source that is simply absent —
 * a session nobody stated a name for, a card with no title yet — and making the
 * caller guard as well as `bestName` put the same test in two places at every
 * site.
 */
export type NameClaim = { name: string | undefined; rung: NameRung };

/** A claim that actually names something — the only kind `bestName` answers
 *  with, so a caller building a card gets a `name` it can use unchecked. */
export type FoundName = { name: string; rung: NameRung };

/**
 * What kind of claim a `Session.nameSource` describes.
 *
 * `ai-title` is `discover`'s word for a guess it read out of a transcript and
 * `generated` is what `live.ts` publishes for one it asked for; they are the
 * same claim and rank as one. `stated` is not reachable from here — a store
 * entry is not a `Session` field — so the caller holding one states that rung
 * itself.
 *
 * **A word this repo has never seen counts as `given`**, which is the safe
 * direction and the one `discover`'s own guard already takes: a CLI that
 * invents a third spelling for "somebody typed this" is then read as a
 * statement rather than as a guess we may overwrite.
 */
export function rungOf(nameSource: string | undefined): NameRung {
  switch (nameSource) {
    case 'derived':
      return 'derived';
    case 'prompt':
      return 'prompt';
    case 'generated':
    case 'ai-title':
      return 'generated';
    default:
      return 'given';
  }
}

/**
 * The word a rung goes out as.
 *
 * The top two publish nothing, which is the CLI's own convention for a name
 * somebody stated — a derived name spells `nameSource` out, an explicit one
 * omits it — so a card synthesised here and the session file the CLI writes
 * agree, and `displayName` leaves the name alone rather than folding it.
 */
export function sourceOf(rung: NameRung): string | undefined {
  return rung === 'stated' || rung === 'given' ? undefined : rung;
}

/**
 * The best of several claims, or nothing when none of them names anything.
 *
 * A missing or blank name is skipped rather than ranked: most sources are
 * absent most of the time, and every one of them has also been seen to answer
 * with an empty string. A card falls to the next rung rather than showing a gap
 * where a name goes.
 *
 * **Ties go to the last**, so a caller lists its candidates weakest-first
 * within a rung. The tie that matters is two `given` names — the one this
 * window spawned under, and the one a `/rename` in the CLI's own UI has since
 * written into the session file. The file is the newer answer, and catching it
 * one poll later is the whole reason the fold reads it at all.
 */
export function bestName(claims: readonly NameClaim[]): FoundName | undefined {
  let best: FoundName | undefined;
  for (const { name, rung } of claims) {
    if (name && (!best || RUNGS.indexOf(rung) <= RUNGS.indexOf(best.rung))) {
      best = { name, rung };
    }
  }
  return best;
}
