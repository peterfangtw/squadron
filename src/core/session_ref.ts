/**
 * A reference to one session, as text another session's agent can act on:
 * `@squadron[<pid>][<transcript>]`. The pid is what `squadron-send` takes, the
 * path is the file to read — so neither needs a `squadron-list` lookup first.
 *
 * A leaf, like `tokens.ts`: the host writes it onto the clipboard, and the
 * webview finds it again to draw a pill, in the box and in the dock.
 */

export type SessionRef = { pid: number; transcript: string };

export function refFor(pid: number, transcript: string): string {
  return `@squadron[${pid}][${transcript}]`;
}

/**
 * What a reference is called in a pill: its card's name while there is one, its
 * pid after. The pid may have been reused by then — accepted.
 */
export function refLabel(pid: number, name: string | undefined): string {
  return `@${name ?? `session ${pid}`}`;
}

// A path with `]` or a line break in it is not one this matches. No brand's
// transcript directory writes either.
const REF = /@squadron\[(\d+)\]\[([^\]\n]+)\]/g;

/** Every reference in `text`, left to right. */
export function findRefs(text: string): (SessionRef & { at: number; text: string })[] {
  return [...text.matchAll(REF)].map((m) => ({
    at: m.index,
    text: m[0],
    pid: Number(m[1]),
    transcript: m[2] ?? ''
  }));
}
