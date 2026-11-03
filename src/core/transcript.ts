/**
 * The product thread: what a turn is, and the write-pill helpers the dock uses.
 *
 * Claude's path and jsonl readers live in `core/claude/transcript.ts`. Grok
 * has its own readers and imports these types.
 */

import * as path from 'path';
import type { WarmTurn } from './model';

/**
 * One thing the thread shows. The CLI writes skill bodies and interrupt notices
 * down as user turns, so a `Marker` carries no `role` and no `text` — it cannot
 * be mistaken for a prompt by anything downstream.
 */
export type Exchange = Authored | Marker;

export const LIVE_USER_TURNS = 10;

export function recentUserFrom(
  exchanges: readonly { role?: string; maintenance?: boolean; mark?: string }[]
): number {
  let users = 0;
  let from = 0;
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const row = exchanges[i];
    if (row?.role !== 'user' || row.maintenance) continue;
    users++;
    if (users === LIVE_USER_TURNS) from = i;
    if (users > LIVE_USER_TURNS) return from;
  }
  return 0;
}

/** A turn somebody produced: the person, the model, or the CLI in its place. */
export type Authored = {
  /**
   * `cli` is a turn the CLI wrote where the model's would be — an API error, a
   * usage limit. It did write it, so it keeps an author.
   *
   * `wait` is a registered wait converging. A callback in the extension host
   * composed it, not a session, so like `cli` it keeps an author of its own. It
   * carries text (which members, how each finished), so it cannot be a
   * `Marker`. It never carries a `from`: `WAIT_OPEN`
   * (`core/coordination/send.ts`) says why.
   *
   * `warm` is a cache-warming ping the window wrote. Raw records keep it, so
   * activity clocks can skip it; only the dock's projection (`foldWarm`)
   * redraws it.
   */
  role: 'user' | 'assistant' | 'cli' | 'wait' | 'warm';
  /**
   * A `cli` turn that is a slash command's own output rather than the CLI
   * speaking where the model failed to. A flag and not a role, because the
   * author is the same and only the drawing differs: the rest of `cli` is
   * painted as an alarm.
   */
  local?: true;
  /** Explicit ownership captured on the pipe; false starts real output. */
  maintenance?: boolean;
  /** The admitted ping input owning this row, independent of arrival order. */
  warmId?: string;
  warmEvidence?: WarmTurn;
  text: string;
  /**
   * What the turn is made of, in the order the entry wrote it: prose and calls
   * interleaved, so "let me check" -> `Bash` -> "found it" stays three things.
   *
   * `text` above is the same prose joined, and stays — the composer matches a
   * sent message against it, `stillQueued` retires an entry by it.
   */
  blocks?: Block[];
  /** When the CLI wrote the entry, epoch ms. Absent when it stamped none or
   *  something unparseable. Such a turn still shows but cannot be measured. */
  at?: number;
  /** Files the turn wrote, in the order it wrote them, deduped. Absolute — the
   *  entry a relative `file_path` was written on is the only place its cwd
   *  survives, so it is resolved here. See `AuthoredView` for what that buys. */
  files?: string[];
  /** How much of each of those files the turn wrote, keyed by the same absolute
   *  path. A sidecar rather than a field on `files`, so no reader of that array
   *  changes, at the price of two structures merged by two rules (`addWritten`).
   *  `Object.keys(sizes) ⊆ files` at every merge point, which
   *  `transcript.test.ts` and `fold.test.ts` assert.
   *
   *  A path in `files` with no entry here is a write `sizeOf` could not read
   *  (drawn by `webview/chat.ts`'s `counts`). A write no frame carries, such as
   *  a `Bash` heredoc, is in neither, because it has no pill (see `WRITES`). */
  sizes?: Record<string, Written>;
  /** Whole-turn baseline for a pill’s diff; absent when capture is unavailable. */
  base?: string;
  /** A path this turn changed was left out, because another session's turn
   *  overlapped this one and touched the same file. A fact about the window, not
   *  about any file in the list. Why, and the census: `Attributed.concurrent`
   *  (`core/checkpoint.ts`). */
  concurrent?: true;
  /** Images the turn carried, named rather than carried — see `ImageRef`. The
   *  bytes are most of a megabyte and the dock repaints every couple of
   *  seconds, so they are fetched only when a reader opens one. */
  images?: ImageRef[];
  /** The skill this turn ran under, from the entry's own `attributionSkill`.
   *  Present on every turn of a skill's run, so it reads as a span. */
  skill?: string;
  /**
   * The session that sent this turn, for a message another session addressed to
   * this one. A `user` turn, because somebody authored it. Same axis as
   * `skill`: who is behind the words. Absent for every turn a person typed.
   */
  from?: string;
  /**
   * The message stopped before its CLI completed it — an interrupt, an error,
   * the child dying — and this is the text that had arrived. Kept because the
   * reader already saw those words (`core/thread.ts`, `cut`).
   * Additive on the record, so `SCHEMA` does not move.
   */
  cut?: true;
};

/**
 * A slash command's answer, as the dock draws it: the `local` CLI turn.
 *
 * One spelling for every source: the CLI's own, off its file
 * (`claude/transcript.ts`) or its pipe (`claude/tee.ts`), and the panel's, for a
 * command it answers without any CLI (`SessionHandle.readout`).
 */
export function localReply(text: string, at: number | undefined): Authored {
  return { role: 'cli', local: true, text, blocks: [{ text }], at };
}

/**
 * One piece of a turn: a run of prose, or a call the turn made.
 *
 * `summarized` marks prose the CLI's server rewrote rather than the model's own
 * words — Claude's narration (`core/claude/narration.ts`). Still the turn's
 * prose, and drawn as such, with the dock saying it is a summary.
 */
export type Block = { text: string; summarized?: true } | { call: ToolCall };

/**
 * One tool call, and what it returned. Held as the CLI wrote it — the wording of
 * a row is `ui/activity.ts`'s decision. What this side owns is the size: a
 * `Write` carries a whole file, and this parse is cached and re-shipped on every
 * poll, so `input` is scrubbed and `output` truncated on the way in.
 */
export type ToolCall = {
  /** The CLI's own `tool_use.id`. Every result on this machine names one, so
   *  pairing is an id lookup. Empty for a call written without one, which never
   *  pairs. */
  id: string;
  name: string;
  /** The input, bounded: strings cut, arrays cut, depth capped. */
  input?: Record<string, unknown>;
  /** What the call returned, cut to `MAX_OUTPUT`. Absent while it is still
   *  running — 2 calls in 2533 are in that state at any moment — and absent for
   *  one whose result sits outside the window this read covers. */
  output?: string;
  /** The result said so, off its own `is_error`. */
  failed?: boolean;
  /** An `AskUserQuestion`'s whole record — the questions, and what was answered
   *  — off the result entry's `toolUseResult`. Absent for every other tool, and
   *  for an ask whose result this read never reached. */
  ask?: AnsweredAsk;
};

/**
 * An ask somebody has already answered, as the CLI that ran it wrote it down.
 *
 * Held keyed by question text rather than indexed, because that is how the CLI
 * writes it and re-keying here would be a second place for the two halves to
 * disagree. `core/answers.ts` resolves it to indices — the inverse of the
 * payload it composes going the other way.
 *
 * **Here rather than in `claude/asks.ts`.** `ToolCall.ask` is a field of a
 * shape every brand mints, and a record is written by whichever CLI held the
 * pipe, so the type a second brand fills in may not be reached through the
 * first one's module. `PendingQuestion` is already ambient
 * (`protocol.d.ts`) for the same reason. Each brand's own parse of its own wire
 * — `parseAnswered` for Claude, `grok/asks.ts` for Grok — stays where it is.
 */
export type AnsweredAsk = {
  questions: PendingQuestion[];
  /** Keyed by the full question text, as `answerPayload` keys it. An array is a
   *  multi-select; a string is one label, or the reader's own words. */
  answers: Record<string, string | string[]>;
  /** Keyed the same, and narrowed to the one field a reader typed. */
  annotations: Record<string, { notes?: string }>;
};

/**
 * Something that happened to the conversation rather than in it: a skill
 * loading, a request cut short, the CLI starting a turn nobody prompted. The
 * dock owns the words for all three.
 *
 * `skill` carries `skill` and `by`; `break` carries nothing; `trigger` carries
 * `trigger`, `status` when the CLI stated one, and `at`.
 */
export type Marker = {
  mark: 'skill' | 'break' | 'trigger';
  /** The skill's name, when the transcript names it. A skill it cannot name is
   *  not marked at all, so this is present on every `skill` and on nothing
   *  else. */
  skill?: string;
  /** Who reached for it. A skill typed as `/name` is the reader's own turn —
   *  the CLI records the command and the body it expanded to, and neither is a
   *  turn, so without this the thread would show a session running a skill
   *  nobody can see was asked for. `skill` only. */
  by?: 'you' | 'agent';
  /** What started the turn that follows: a background command (`task`, its
   *  first value, kept so older records read unchanged) or a background agent.
   *  A union so a later cause is one more value rather than one more mark.
   *  `trigger` only. */
  trigger?: 'task' | 'agent';
  /** How the thing that triggered the turn ended, in the CLI's word. Absent
   *  when the CLI's word was missing or unreadable. `trigger` only. */
  status?: 'completed' | 'failed' | 'stopped';
  /** When the trigger reached us, epoch ms, so a fold of the turn it starts
   *  times from it rather than from the turn before. `trigger` only. */
  at?: number;
};

/**
 * How much of a call's output a thread keeps, whichever brand wrote it. t3code's
 * number: over 2531 Claude results (2026-07-29) only a quarter already fit —
 * p50 495 characters, longest 63k — and Grok's 01a00db4 wrote one of 102KB.
 * The dock draws one line, and a record is read whole on every poll.
 *
 * The first line is the one worth having: a failing `Bash` opens with `Exit
 * code N`, a `Read` with the file's first line. Which is why nothing strips off
 * the end the way the port's source did — see `ui/activity.ts`.
 */
export const MAX_OUTPUT = 180;

/**
 * Output as a thread keeps it: trimmed, cut to `MAX_OUTPUT` with an ellipsis
 * as the only mark of the cut, and nothing for blank text. Every brand's
 * reader decodes its own shape first and cuts here, so a call row does not
 * change length when the dock swaps sources.
 */
export function cutOutput(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > MAX_OUTPUT ? trimmed.slice(0, MAX_OUTPUT) + '…' : trimmed;
}

/** Retained echo/recovery row target; complete live user turns may exceed it. */
export const MAX_TURNS = 400;

/**
 * How many consecutive failed stats a reader holds its last reading for.
 *
 * Here for `MAX_TURNS`'s reason. A record and a transcript that let go of the
 * same deleted conversation on different polls would draw a thread that half
 * exists.
 *
 * A lost read is transient — EMFILE, a read racing the writer — and the next
 * poll gets the file. A *deleted* one fails every stat, and holding its reading
 * forever draws a gone conversation for the life of the panel. Three at a 3s
 * poll is ~9s: long enough that nothing transient reaches it, short enough that
 * a cleanup of `~/.claude/projects` shows while the reader is still looking at
 * the same screen.
 */
export const HOLD_MISSES = 3;

/** Whether an exchange is one nobody authored. */
export function isMarker(x: Exchange): x is Marker {
  return 'mark' in x;
}

/**
 * Which turns a cache-warming ping owns, by index. Explicit pipe ownership
 * ends the span at correlated completion, including a later unsolicited turn.
 * Legacy rows without ownership fall back to the `warm` turn and all that
 * follows it up to the next real input — a `user` turn (a peer's included), a
 * `wait`, a skill the reader typed, or a trigger. Each puts something new
 * before the model, so what follows answers it and not the ping. A `cli` turn and a
 * `break` are the CLI speaking inside whichever turn is running, so they stay
 * with it. Each ping opens a span of its own.
 *
 * Read over raw rows — a record's, or the dock's before it folds them — for the
 * activity clock and the dock's projection alike. Neither reads the other's
 * output.
 */
export function warmOwned(
  turns: readonly (
    { role: string; maintenance?: boolean; warmId?: string } | { mark: string; by?: string }
  )[]
): boolean[] {
  let owned = false;
  return turns.map((turn) => {
    if ('mark' in turn) {
      if ((turn.mark === 'skill' && turn.by === 'you') || turn.mark === 'trigger') owned = false;
    } else if (turn.role === 'warm') {
      owned = true;
    } else if (turn.role === 'user' || turn.role === 'wait') {
      owned = false;
    }
    if ('role' in turn && turn.role !== 'warm' && turn.warmId !== undefined)
      return turn.maintenance !== false;
    if ('role' in turn && turn.maintenance !== undefined) owned = turn.maintenance;
    return owned;
  });
}

/**
 * What the last completed turn ended on: the prose of the last answer after
 * its prompt, as a finished notice quotes it. The answer is the model's, or
 * the CLI's in its place; the prompt is a person's or a peer's turn, or a wait
 * arriving. A cache-warming ping and its answer are skipped (`warmOwned`), so a
 * ping between a finish and its notice does not take the finish's words.
 *
 * `inFlight` says the last prompt began a turn that has not ended — a held
 * reply drained before the pass that saw the finish — so that turn, prompt and
 * all, is passed over and the one before it quoted. Without it, the trailing
 * turn is taken as finished.
 *
 * The last answer with prose, not the last answer: a turn often ends on a call
 * after its summary. Nothing when the turn said nothing in words.
 */
export function lastAnswer(
  exchanges: readonly Exchange[],
  options: { inFlight?: boolean } = {}
): string | undefined {
  const warm = warmOwned(exchanges);
  const end = options.inFlight
    ? (lastPrompt(exchanges, warm) ?? exchanges.length)
    : exchanges.length;
  for (let i = end - 1; i >= 0; i--) {
    const one = exchanges[i];
    if (one === undefined || warm[i] || isMarker(one)) continue;
    if (isPrompt(one)) return undefined;
    if (one.role !== 'assistant' && one.role !== 'cli') continue;
    const prose = (one.blocks ?? [{ text: one.text }]).flatMap((block) =>
      'text' in block && block.text.trim() !== '' ? [block.text] : []
    );
    if (prose.length) return prose.join('\n\n');
  }
  return undefined;
}

/**
 * Whether the last thing said is a prompt nothing has answered: a turn begun,
 * as a record read moments after the pass that saw its predecessor end can
 * show. A ping and its answer are skipped, as in `lastAnswer`.
 */
export function unanswered(exchanges: readonly Exchange[]): boolean {
  const warm = warmOwned(exchanges);
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const one = exchanges[i];
    if (one === undefined || warm[i] || isMarker(one)) continue;
    return isPrompt(one);
  }
  return false;
}

/** The index of the last prompt, past pings. */
function lastPrompt(exchanges: readonly Exchange[], warm: readonly boolean[]): number | undefined {
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const one = exchanges[i];
    if (one !== undefined && !warm[i] && !isMarker(one) && isPrompt(one)) return i;
  }
  return undefined;
}

function isPrompt(one: Authored): boolean {
  return one.role === 'user' || one.role === 'wait';
}

/**
 * The tools whose `file_path` is a file the turn produced rather than one it
 * looked at. Counted over all 927 transcripts here, 2026-07-29: `file_path`
 * rides `Edit` (9810), `Read` (6163), `Write` (907) and nothing else a thread
 * keeps. `Read` is browsing, so only the writers are here. `MultiEdit` and
 * `NotebookEdit` never appeared and are listed anyway, at a string each.
 *
 * A `Bash` redirect writes a file this cannot see, deliberately: finding it
 * means parsing shell, and a missing pill beats one naming a file never written.
 */
export const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Lines added and removed by one turn's writes to one file. */
export type Written = { add: number; del: number };

export type Recent = { exchanges: Exchange[]; truncated: boolean };

/** Fold one call's write into a running per-file tally. `files` dedupes a path;
 *  this sums it, because two edits to one file are one pill and two changes. */
export function addWritten(into: Record<string, Written>, file: string, more: Written): void {
  const running = into[file];
  if (running) {
    running.add += more.add;
    running.del += more.del;
  } else {
    into[file] = { ...more };
  }
}

/**
 * The lines a string is. `split('\n')` yields a phantom last line for every
 * string ending in a newline, which is most `Write` content and many a
 * `new_string` — an off-by-one on every count rather than an edge case.
 */
function lines(text: string): string[] {
  if (!text) return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  return out;
}

function countLines(text: string): number {
  return lines(text).length;
}

/**
 * One replacement, minus the context around it. An `Edit`'s `old_string` is
 * whatever the agent needed to match uniquely, not a hunk: change one line
 * inside a 400-line quote and both sides are 400 lines, so an untrimmed delta
 * reports the size of the anchor. The pill exists to state magnitude, and that
 * number would be the magnitude of the agent's caution instead.
 *
 * Trimming the common prefix and suffix *is* the diff here — an `Edit` is one
 * contiguous replacement, and a `MultiEdit` is one per hunk. An LCS would
 * differ only where a single hunk interleaves added and removed lines, which is
 * a smaller error than the one this fixes and not worth a dependency.
 *
 * What is left against `git diff`: git counts a newline arriving at the end of
 * a file as a change to that last line (`\ No newline at end of file`), so
 * `b` -> `b\nc\n` is `+2 −1` there and `+1 −0` here. The net is the same, which
 * is the number the pill states.
 */
function hunk(old: string, neu: string): Written {
  const a = lines(old);
  const b = lines(neu);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  return { add: b.length - head - tail, del: a.length - head - tail };
}

/**
 * What one call wrote, or `undefined` when its input is not a shape this knows.
 *
 * Read off the raw block, before `scrub` — that cut is 300 characters
 * (`MAX_INPUT`) and eight array items (`MAX_ITEMS`), so a count taken anywhere
 * downstream under-reports every edit longer than a paragraph and drops the
 * ninth hunk of a `MultiEdit`.
 *
 * Two limits it cannot see, both recorded in `TASK_done_change_size.md`: a
 * `Write` that overwrites reports everything it wrote and never a deletion,
 * because the frame does not carry what was there before; and `replace_all`
 * multiplies a hunk by an occurrence count the frame does not state, so one is
 * reported.
 *
 * `NotebookEdit` is deliberately absent. `notebook_path` is the only key it
 * writes (`ui/activity.ts`), so the `file_path` read below never fires for one
 * and it has no pill to carry a size — it is in `WRITES` only so a tool row is
 * classed as a write.
 */
export function sizeOf(name: string, input: WriteInput | undefined): Written | undefined {
  if (!input) {
    return undefined;
  }
  if (name === 'Write') {
    return typeof input.content === 'string'
      ? { add: countLines(input.content), del: 0 }
      : undefined;
  }
  if (name === 'Edit') {
    return typeof input.old_string === 'string' && typeof input.new_string === 'string'
      ? hunk(input.old_string, input.new_string)
      : undefined;
  }
  if (name === 'MultiEdit') {
    if (!Array.isArray(input.edits)) {
      return undefined;
    }
    const total = { add: 0, del: 0 };
    for (const one of input.edits) {
      if (typeof one?.old_string !== 'string' || typeof one?.new_string !== 'string') {
        return undefined;
      }
      const part = hunk(one.old_string, one.new_string);
      total.add += part.add;
      total.del += part.del;
    }
    return total;
  }
  return undefined;
}

/** The fields a size is read off, narrowed like every other parse here. */
export type WriteInput = {
  file_path?: unknown;
  content?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  edits?: { old_string?: unknown; new_string?: unknown }[];
};

/**
 * Fold one call's write into a turn's running `files` and `sizes`, or do
 * nothing when the call wrote no file this can name.
 *
 * One copy for every brand. Each of the three questions here — is this tool a
 * writer, which file did it name, how much of it did it write — is asked in our
 * own vocabulary, downstream of the `TOOLS` map where a reader's last brand fact
 * lives. Spelt once per reader, the same rule would have to change in two files.
 *
 * `input` must be the **raw** input, before any scrub (see `sizeOf`).
 */
export function noteWrite(
  files: string[],
  sizes: Record<string, Written>,
  name: string,
  input: WriteInput | undefined,
  cwd: string | undefined
): void {
  const wrote = input?.file_path;
  if (!WRITES.has(name) || typeof wrote !== 'string' || !wrote) {
    return;
  }
  // Relative about a third of one percent of the time on Claude and 0.66% on
  // Grok, and the entry it was written on is the only place the directory it was
  // relative to survives.
  //
  // With no cwd, the path is dropped rather than resolved: `path.resolve` would
  // hand back one under the extension host's own working directory — a pill
  // naming a file nothing wrote, opening on a path that may well exist (see
  // `WRITES`).
  if (!path.isAbsolute(wrote) && !cwd) {
    return;
  }
  // `resolve` hands an absolute path straight back, so this is one call for
  // both shapes.
  const file = path.resolve(cwd ?? '', wrote);
  if (!files.includes(file)) {
    files.push(file);
  }
  const size = sizeOf(name, input);
  if (size) {
    addWritten(sizes, file, size);
  }
}
