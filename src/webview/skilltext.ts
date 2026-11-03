/**
 * Naming a skill in prose: the one spelling that works, and where it occurs.
 *
 * A leaf on purpose — no DOM, no imports but `core/tokens.ts`. Every box that
 * forms a skill chip and the dock that pills one need these facts, and a rule
 * this measured should be unit-testable rather than reachable only through a
 * jsdom paint.
 */

import * as tokens from '../core/tokens';

/**
 * What naming a skill in prose looks like, and the only spelling measured to
 * work: it makes the model call its `Skill` tool, once per name and in the order
 * named, where a `/slash` line expands only the leading token and a path turns
 * `Skill` into `Read`. The name is carried **verbatim** — a namespaced name
 * shortened to its alias loads nothing while still answering as though it had.
 *
 * One copy, deliberately. This string is the most-measured thing in the feature,
 * and two homes for it is two chances to drift.
 */
export const expansionFor = (name: string): string => `the ${name} skill`;

/**
 * A letter, a digit, an underscore or a hyphen — what may not sit against a
 * phrase.
 *
 * `\p{L}\p{N}` rather than `A-Za-z0-9`: with an ASCII class every non-ASCII
 * letter reads as a boundary, so `the design skillé` pills the phrase and
 * orphans the `é` — byte for byte the plural bug this filter exists to stop,
 * re-armed for every prompt that is not pure English. `_` is in for the opposite
 * reason: it is a word character to a reader (`the design skill_v2` is one
 * identifier) and to no character class that omits it. `-` for the same
 * reason: `the design skill-set` is a compound, not a mention.
 *
 * `mention_text.ts` holds a model expansion to the same rule.
 */
export const WORD = /[\p{L}\p{N}_-]/u;

/**
 * Where a skill is named in ordinary prose, bounded by non-word characters.
 *
 * `scan` is longest-first, so `the ponytail-audit skill` wins over `the
 * ponytail skill` at the same index, and hits never overlap. It matches raw
 * substrings. Formation and the dock both read through this filter: without
 * it, `the design skills` paints a pill and orphans the `s`, and `soothe
 * design skill` paints one starting inside `soothe`.
 */
export function skillPhrases(
  text: string,
  names: readonly string[]
): { at: number; text: string }[] {
  return tokens.scan(text, names.map(expansionFor)).filter((hit) => {
    const before = hit.at > 0 ? text.charAt(hit.at - 1) : '';
    const after = text.charAt(hit.at + hit.text.length);
    return !WORD.test(before) && !WORD.test(after);
  });
}
