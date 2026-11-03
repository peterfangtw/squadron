/**
 * The bound every brand's tool input passes through on the way into a thread.
 *
 * Neutral, and here rather than in either CLI's module, for `AnsweredAsk`'s
 * reason (`06afc1f`): `ToolCall.input`'s contract says *bounded*, `ToolCall` is
 * a shape every brand mints, and the second brand to need this may not reach it
 * through the first one's transcript reader. Nothing in it is a reading of any
 * CLI's spelling — it is arithmetic over a JSON value.
 */

/**
 * How much of a tool's input is kept. Arithmetic, not CLI knowledge:
 * `Write.content` is a whole file and `Edit` carries both sides of every hunk,
 * while a parse ships to the webview on every 3s poll — and a row is drawn
 * from a key and a path, so a few hundred characters is all one can use.
 *
 * Measured over the ten largest transcripts (2026-07-29): the 2MB tail holds
 * 10-192 calls, so a scrubbed poll costs ~100KB at worst and needs no per-turn
 * cap on top. A tee pays it for a second reason — what a record keeps, it keeps
 * for good, where a re-read of the CLI's own file is transient.
 */
const MAX_INPUT = 300;
const MAX_ITEMS = 8;
/**
 * Measured over 59,574 tool calls in 1,200 transcripts (2026-08-21): 58,984 are
 * one level deep, 23 are two or three, **none is four**, and 543 are five — all
 * 543 of them an `AskUserQuestion`, whose input is
 * `questions[].options[].label`. Nothing on this machine is deeper.
 *
 * So four capped exactly one shape, and cut it to `"options":[null,null,null,null]`
 * — an ask recorded with its picks erased.
 */
const MAX_INPUT_DEPTH = 5;

/**
 * A value bounded on the way in, so nothing downstream has to remember to slice.
 * Shape-preserving — `ui/activity.ts` looks for keys it knows by name — with
 * long strings cut and long lists and deep parts dropped.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_INPUT ? value.slice(0, MAX_INPUT) : value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_INPUT_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    // Filtered for the object branch's reason: a cut entry is an omission, and
    // an array that held it serialised as `[null,null]` — indistinguishable
    // from a list the tool really sent nulls in, since `null` survives above.
    return value
      .slice(0, MAX_ITEMS)
      .map((entry) => scrub(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  const out: Record<string, unknown> = {};
  // Every field, however many: an input's weight is its strings, cut above.
  // Wider than eight fields turned up twice in 48,222 calls across 974
  // transcripts (2026-07-29), and both times a capped loop would have dropped a
  // key `ui/activity.ts` reads — a summary lost for no bytes saved.
  for (const [key, held] of Object.entries(value)) {
    const kept = scrub(held, depth + 1);
    if (kept !== undefined) {
      out[key] = kept;
    }
  }
  return out;
}

/** An input as a call carries it: an object, bounded, or nothing at all — a
 *  call whose input the CLI wrote as a bare string still gets a row. */
export function scrubbedInput(value: unknown): Record<string, unknown> | undefined {
  const scrubbed = value === null || typeof value !== 'object' ? undefined : scrub(value);
  return scrubbed && !Array.isArray(scrubbed) ? (scrubbed as Record<string, unknown>) : undefined;
}
