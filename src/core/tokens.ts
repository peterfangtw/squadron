/**
 * Ranges of known phrases in a string, and the splice that replaces them.
 *
 * A leaf the webview bundles, beside `markers.ts`. `skilltext.ts` scans skill
 * phrases, `mention_text.ts` merges its readers with `disjoint`, and the dock
 * splices those hits into pills. Longest-first, so a phrase that contains a
 * shorter one wins, and a replacement is never scanned again.
 */

/**
 * Ranges of known tokens in `text`, longest-first matching, non-overlapping,
 * left to right.
 */
export function scan(text: string, tokens: readonly string[]): { at: number; text: string }[] {
  if (!tokens.length || !text) return [];
  const ordered = [...tokens].sort((a, b) => b.length - a.length);
  const hits: { at: number; text: string }[] = [];
  let i = 0;
  while (i < text.length) {
    let found: string | undefined;
    for (const token of ordered) {
      if (text.startsWith(token, i)) {
        found = token;
        break;
      }
    }
    if (found) {
      hits.push({ at: i, text: found });
      i += found.length;
    } else {
      i += 1;
    }
  }
  return hits;
}

/**
 * Hits from several readers as `splice` takes them: left to right, never
 * overlapping. The earlier hit wins and one starting inside it is dropped; at
 * one index the hit listed first wins, so a caller orders its readers by
 * precedence.
 */
export function disjoint<H extends { at: number; text: string }>(hits: readonly H[]): H[] {
  let end = 0;
  return [...hits]
    .sort((a, b) => a.at - b.at)
    .filter((hit) => {
      if (hit.at < end) return false;
      end = hit.at + hit.text.length;
      return true;
    });
}

/** Hits must already be ordered and non-overlapping, as scan returns them. */
export function splice<H extends { at: number; text: string }, T>(
  text: string,
  hits: readonly H[],
  swap: (hit: H) => T
): (string | T)[] {
  const parts: (string | T)[] = [];
  let cut = 0;
  for (const hit of hits) {
    if (hit.at > cut) parts.push(text.slice(cut, hit.at));
    parts.push(swap(hit));
    cut = hit.at + hit.text.length;
  }
  if (cut < text.length) parts.push(text.slice(cut));
  return parts;
}
