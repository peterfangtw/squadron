/**
 * `[Image #N]` — the marker the composer leaves where an image was pasted,
 * mirroring the CLI's own TUI.
 *
 * An image never rides inside the prose: `userMessage` writes a message's text
 * block and then its images, which is what the CLI does with a paste too. So
 * the only way a message can say *which* image it means is by number, and N is
 * the image's place in the prompt's images — the order the blocks are sent in,
 * not the order the markers appear in the text.
 *
 * Its own module, and deliberately the smallest one here: this is the single
 * rule both halves of the panel have to agree on, and the two of them cannot
 * share `pastes.ts` — that file reads and writes files, which the webview's
 * bundle cannot take. Nothing is imported here, by design. A second copy of
 * this pattern is how a renumber once grew a space the reader never typed.
 *
 * Every rewrite below is bounded by `count`, the images the message in hand
 * actually carries. A higher number is prose — "as in [Image #7] earlier" is
 * about a turn that has already happened — and rewriting it would put words in
 * the reader's mouth about something this panel never held.
 */

const MARKER = /\[Image #(\d+)\]( ?)/g;

/**
 * The prose under the markers. What a message is *about* is never the marker —
 * it is a pointer, and one that is all pointers says nothing a reader meant.
 * Used where text stands in for intent rather than for content: naming a
 * session after its first message, and matching an echo against the turn it
 * became once a merge has renumbered it.
 */
export function withoutImageMarkers(text: string): string {
  return text.replace(MARKER, '').replace(/ {2,}/g, ' ').trim();
}

/**
 * Renumbers by `offset`, for the merge that puts several held messages on the
 * pipe as one turn: their images flatten into a single list, so the second
 * message's `#1` is now the third image and has to say so.
 */
export function shiftImageMarkers(text: string, offset: number, count: number): string {
  if (!offset || !count) {
    return text;
  }
  return text.replace(MARKER, (mark, digits: string, space: string) => {
    const n = Number(digits);
    return within(n, count) ? `[Image #${n + offset}]${space}` : mark;
  });
}

function within(n: number, count: number): boolean {
  return n >= 1 && n <= count;
}
