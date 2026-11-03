/**
 * What a tool call did, in the reader's words: any call's payload -> the one
 * line the dock puts beside it.
 *
 * Ported from t3code's `packages/shared/src/toolActivity.ts` (MIT, Copyright
 * (c) 2026 T3 Tools Inc. — https://github.com/pingdotgg/t3code), read at commit
 * 23b5502, 2026-07-26. The upstream file's terms travel with this port.
 *
 * What carried over is the shape: classify into
 * `command | read | file_change | search | other`, ask each class for the one
 * string it is about, and answer everything unrecognised by looking under the
 * keys a path is written under.
 *
 * What did not carry over is the vocabulary, and that is the whole port.
 * t3code reads its own provider runtime — `data.item.input`, `rawInput`,
 * `locations`, `changes` — where this reads the CLI's raw `tool_use.input`, so
 * classification keys off the tool's **name** first. That is a fact where
 * their `kind`/`title` sniffing was a guess, and it is why the path lookup is
 * the fallback here rather than the main path.
 *
 * Four upstream helpers are gone, all measured dead against this machine's
 * transcripts (2026-07-29): the `bash -lc "…"` unwrapper, 0 of 2261 `Bash`
 * calls; the `<exited with exit code N>` stripper, 1 of 2531 results — the CLI
 * writes a *leading* `Exit code N` line instead, which is at the end of nothing
 * and survives truncation on purpose; the recursive path scrape, which over
 * 48,222 calls in 974 transcripts found something below the top level twice,
 * both in one tool's array of findings, and whose replacement is the lookup
 * that was already its first step; and `isEquivalent`, which dropped a detail
 * that only restated its summary — 0 of the 6,082 calls that reach the branch
 * it guarded. Don't re-add any of them off the doc row; re-measure first.
 */

import { readAnswers } from '../core/answers';
import { ToolCall, WRITES } from '../core/transcript';
import { shorten } from './text';

/** One call's words: what it did, and the one thing it did it to. */
export type Activity = {
  summary: string;
  /** The line under the summary. Already shortened for a 400px column. */
  detail?: string;
  /** The unshortened form, for a tooltip — a long command, a whole path. Set
   *  only when it says more than `detail` does. */
  title?: string;
};

/**
 * Where a path hides, in the CLI's own spellings. Ordered: the first hit wins,
 * and `file_path` is what 17,295 of this machine's calls use, against 49 for
 * `path` and 5 for `filename`.
 *
 * Upstream's camelCase — `filePath`, `relativePath`, `newPath`, `oldPath` — and
 * a bare `file` stood here too, and are gone: 0 of 48,222 calls, because they
 * were their provider runtime's words and no CLI tool writes them.
 * `notebook_path` stays unmeasured on purpose — it is the only key
 * `NotebookEdit` writes, and `NotebookEdit` is in `WRITES`.
 */
const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'filename'];

/** What a search was for. Two, for the two tools left in `search`: `query` is
 *  `WebSearch`'s and `url` is `WebFetch`'s. */
const QUERY_KEYS = ['query', 'url'];

/**
 * How a call is summarised, and where its subject hides. Four of upstream's
 * five, from a union that used to be written out three times — here, in a
 * summary record, and in the cascade below — so that adding a class meant three
 * coordinated edits.
 *
 * `summary` is the dock's word for the action, which is why the words live here
 * beside the icons and not in `core/`. `keys` are the CLI's own spellings of
 * where the subject is written, first hit winning. `row` is how the subject is
 * stated on one line when that is not verbatim, and `whole` is a tooltip the
 * row does not already carry — a shortened `row` hands the subject over on its
 * own, so only `command` needs to say anything.
 *
 * Upstream's fifth, `other`, is the absence of an entry rather than an entry:
 * it has no fixed word — the tool names itself — and no known key, so its
 * subject is looked for instead of read. That is the one branch left below.
 */
const ACTIONS = {
  command: {
    // `description` is the model's own one-line account of the command. It
    // reads where a piped heredoc does not, and the command stays one hover
    // away — the same trade `pills()` makes between a basename and its path.
    //
    // The fallback is not an edge case: 87.9% of 2255 `Bash` calls carry one
    // (2026-07-29), and the share is per *session* rather than per call — one
    // whole session on this machine wrote 71 calls and not one description. So
    // both branches are the normal reading, and neither is the exception.
    summary: 'Ran command',
    keys: ['description', 'command'],
    whole: (input: Record<string, unknown> | undefined, detail: string) => {
      const command = line(input?.['command']);
      // Only when it says something the row does not.
      return command !== detail ? command : undefined;
    }
  },
  read: { summary: 'Read file', keys: PATH_KEYS, row: shorten },
  file_change: { summary: 'Changed file', keys: PATH_KEYS, row: shorten },
  search: { summary: 'Searched', keys: QUERY_KEYS },
  // No keys, and none to add: every value in an `AskUserQuestion`'s input is an
  // array of objects, so `firstStated` finds nothing to say and the row fell to
  // the tool's own name. What the row is about is drawn beside it instead — one
  // pill per question, each wearing that question's header — and a count here
  // would be that same fact a second time.
  ask: { summary: 'Asked', keys: [] }
} as const satisfies Record<string, Reading>;

/** One action's reading. See `ACTIONS`. */
type Reading = {
  summary: string;
  keys: readonly string[];
  row?: (subject: string) => string;
  whole?: (input: Record<string, unknown> | undefined, detail: string) => string | undefined;
};

/** Every action but `other`, which is what having no entry means. */
type Action = keyof typeof ACTIONS;

/**
 * The CLI's own tool names, by what a reader would call them.
 *
 * `WRITES` is `transcript.ts`'s set and is read rather than restated: it is
 * already the answer to "did this tool produce a file", which is the same
 * question this row asks. A tool added there gets a file pill and this word
 * together, which is the pair that would otherwise drift.
 *
 * Only names the CLI ships. `BashOutput`, `KillShell`, `NotebookRead`, `Grep`
 * and `Glob` stood here and are gone: none is in the tool set this CLI offers,
 * and none appears in 48,222 calls across 974 transcripts (2026-07-29). A name
 * this does not know is not a hole — it falls to `other` and gets its own name
 * and its own subject, which is the row `Grep` would have had anyway.
 */
const ACTION = new Map<string, Action>([
  ['Bash', 'command'],
  ['Read', 'read'],
  ['WebSearch', 'search'],
  ['WebFetch', 'search'],
  ['AskUserQuestion', 'ask'],
  ...[...WRITES].map((name): [string, Action] => [name, 'file_change'])
]);

/** Everything past this is a tooltip's job, not a row's. */
const MAX_DETAIL = 200;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A string with something in it, or nothing. Whitespace is nothing. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A value stated as one line: the CLI writes a heredoc into `command` and a
 * whole prompt into `Agent.prompt`, and a row is one line high. An array is
 * joined, because `args` arrives as one.
 */
function line(value: unknown): string | undefined {
  const direct = text(value);
  if (direct !== undefined) {
    return direct.split('\n')[0]?.trim() || undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.map(text).filter((part): part is string => part !== undefined);
  return parts.length ? parts.join(' ') : undefined;
}

/** Whether a string is worth calling a path. Upstream's test, unchanged: a
 *  separator, a leading dot, or an extension. */
function pathLike(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.includes('/') ||
    value.includes('\\') ||
    value.startsWith('.') ||
    /\.[a-z0-9]{1,12}$/i.test(value)
    ? value
    : undefined;
}

/** The first key of `keys` this input states, as one line. */
function first(input: Record<string, unknown> | undefined, keys: readonly string[]) {
  for (const key of keys) {
    const value = line(input?.[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** A tool's name as a reader would read it: an `mcp__server__tool` is its last
 *  segment, since the server is the same for every call in a session. */
function named(name: string): { summary: string; title?: string } {
  const parts = name.split('__');
  const last = parts.at(-1);
  return parts.length > 1 && last ? { summary: last, title: name } : { summary: name };
}

/** A row's line, and the tooltip behind it when the line had to be cut. */
function cut(value: string | undefined): { detail?: string; title?: string } {
  if (value === undefined) {
    return {};
  }
  return value.length > MAX_DETAIL
    ? { detail: value.slice(0, MAX_DETAIL) + '…', title: value }
    : { detail: value };
}

/**
 * What to say about one call.
 *
 * Takes the input as `unknown` and narrows it here, because it is another
 * program's object: a call whose input is a string, a null, or a shape no CLI
 * has written yet still gets a row with the tool's name on it. Nothing in here
 * can throw on a payload, which is the property the whole file is arranged
 * around.
 */
export function activity(call: { name: string; input?: unknown }): Activity {
  const input = record(call.input);
  // The CLI's own flag for input it could not parse. Scraping a shape that is
  // known-broken invents a detail; the name alone is the honest row.
  if (input && '__unparsedToolInput' in input) {
    return named(call.name);
  }
  const action = ACTION.get(call.name);

  if (action) {
    const reading: Reading = ACTIONS[action];
    const subject = first(input, reading.keys);
    if (subject === undefined) {
      return { summary: reading.summary };
    }
    const detail = reading.row ? reading.row(subject) : subject;
    // A row that had to shorten its subject hands the whole of it over; past
    // that, only the action itself knows whether it is holding anything back.
    // Either way the tooltip is stated after `cut`'s, which is the one it beats:
    // the fuller reading is worth more than the tail of a line.
    const title = (detail !== subject ? subject : undefined) ?? reading.whole?.(input, detail);
    return { summary: reading.summary, ...cut(detail), ...(title ? { title } : {}) };
  }

  // Everything else, the CLI's own tools and every `mcp__*` one alike. A path
  // first, because a path is what a row is usually about; the first stated
  // string after that, which is `Skill`'s skill and `TaskCreate`'s subject
  // without either being named here.
  const { summary, title } = named(call.name);
  const detail = pathLike(first(input, PATH_KEYS)) ?? firstStated(input);
  const words = cut(detail);
  // The full name is worth a tooltip only while the detail is not using it: a
  // cut line is the more useful thing to be able to read whole.
  return { summary, ...words, ...(title && !words.title ? { title } : {}) };
}

/**
 * One call as the row the wire carries: its words, plus what it returned.
 *
 * Absent fields are left off rather than sent as `undefined`, because the two
 * are the same thing to a reader and only one of them survives a `postMessage`
 * — a view that states them differently in the panel and in the tests is a view
 * with two shapes.
 */
export function toolView(call: ToolCall): ToolView {
  return {
    ...activity(call),
    ...(call.output !== undefined ? { output: call.output } : {}),
    ...(call.failed ? { failed: true } : {}),
    // Resolved here rather than shipped as the CLI keyed it: matching a label
    // against an option list is `core/answers.ts`'s knowledge, and the webview
    // should never hold a copy of it.
    ...(call.ask ? { ask: { questions: call.ask.questions, ...readAnswers(call.ask) } } : {})
  };
}

/** The first thing an unrecognised input states, in the order its author wrote
 *  the keys — which for every tool observed puts the subject first. */
function firstStated(input: Record<string, unknown> | undefined): string | undefined {
  for (const value of Object.values(input ?? {})) {
    const stated = line(value);
    if (stated !== undefined) {
      return stated;
    }
  }
  return undefined;
}
