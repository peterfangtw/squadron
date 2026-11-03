/**
 * Grok session-dir files: `chat_history.jsonl` for the dock, sibling
 * `updates.jsonl` for CLI-authored alarms, `summary.json` / `signals.json`
 * for card chrome.
 *
 * Path and shape from `docs/reference/cli_state/grok/transcript.md` (1.0.4). Never
 * surface `encrypted_content`. Tool names are mapped into the vocabulary
 * `ui/activity` already classifies, so that file does not learn Grok enums.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readJson } from '../files';
import type { Witness } from '../record';
import { imagePathsIn } from '../pastes';
import { proseImages } from '../prose_images';
import { scrubbedInput } from '../scrub';
import { delivered } from '../coordination/send';
import { grokRoot } from './home';
import { textOf } from './reduce';
import {
  cutOutput as cut,
  noteWrite,
  type Authored,
  type Exchange,
  type Marker,
  type Recent,
  type ToolCall,
  type Written
} from '../transcript';

/** URL-encoded cwd segment. Observed: slashes → `%2F`; do not reuse Claude slugs. */
export function grokCwdSlug(cwd: string): string {
  return encodeURIComponent(cwd);
}

export function grokTranscriptPath(cwd: string, sessionId: string): string {
  return path.join(
    grokRoot(os.homedir(), process.env),
    'sessions',
    grokCwdSlug(cwd),
    sessionId,
    'chat_history.jsonl'
  );
}

/** Title, model, context % from the session dir. Missing files leave gaps. */
export type GrokChrome = {
  title?: string;
  model?: string;
  contextPct?: number;
  contextSize?: number;
};

/**
 * `summary.json` / `signals.json` as observed 1.0.4
 * (`docs/reference/cli_state/grok/sessions.md`). signals appears after a completed turn.
 */
export async function readGrokChrome(cwd: string, sessionId: string): Promise<GrokChrome> {
  if (!cwd || !sessionId) {
    return {};
  }
  const dir = path.dirname(grokTranscriptPath(cwd, sessionId));
  const [summary, signals] = await Promise.all([
    readJson<unknown>(path.join(dir, 'summary.json')),
    readJson<unknown>(path.join(dir, 'signals.json'))
  ]);
  const out: GrokChrome = {};
  if (isRecord(summary)) {
    const title =
      (typeof summary.generated_title === 'string' && summary.generated_title) ||
      (typeof summary.session_summary === 'string' && summary.session_summary) ||
      undefined;
    if (title) {
      out.title = title;
    }
    if (typeof summary.current_model_id === 'string' && summary.current_model_id) {
      out.model = summary.current_model_id;
    }
  }
  if (isRecord(signals)) {
    if (typeof signals.contextWindowUsage === 'number') {
      out.contextPct = signals.contextWindowUsage;
    }
    if (typeof signals.contextWindowTokens === 'number') {
      out.contextSize = signals.contextWindowTokens;
    }
  }
  return out;
}

const TOOLS: Record<string, string> = {
  run_terminal_command: 'Bash',
  list_dir: 'LS',
  write: 'Write',
  // This brand's dominant writer, not a guess: 5,258 calls across the 606
  // sessions on this machine (2026-08-27), against 5,438 `run_terminal_command`
  // and 359 `write`. Its arguments are `Edit`'s shape exactly — `file_path`,
  // `old_string`, `new_string`, `replace_all` — so `sizeOf` reads one unmodified.
  search_replace: 'Edit',
  Write: 'Write',
  read: 'Read',
  Read: 'Read',
  read_file: 'Read',
  grep: 'Grep',
  search: 'Grep'
};

/** A tool as this repo names it. The wire says `read_file` where a row says
 *  `Read`; both readers of this brand go through here so a call does not change
 *  name when the dock swaps sources. */
export function toolLabel(name: string): string {
  return TOOLS[name] ?? name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flatten(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      if (typeof block === 'string') {
        return block;
      }
      if (isRecord(block) && typeof block.text === 'string') {
        return block.text;
      }
      return '';
    })
    .join('');
}

/**
 * Paths Grok wrote into `<image_files>` (1.0.4, `cli_state/grok/README.md` P12). The
 * sibling `{ type: "image", url: "data:…" }` is the same bytes and is a third
 * of a megabyte — naming the file is what `p|` already serves on click.
 *
 * The list is numbered (`1. /abs/….png`). `imagePathsIn` would keep the `1. `
 * and `onDisk` would miss.
 */
function imageRefs(raw: string): ImageRef[] {
  const body = /<image_files>([\s\S]*?)<\/image_files>/.exec(raw)?.[1];
  if (!body) {
    return [];
  }
  return imagePathsIn(body.replace(/^\s*\d+\.\s*/gm, ''))
    .filter((file) => path.isAbsolute(file))
    .map((file) => ({ id: `p|${file}` }));
}

/** The words a person typed. Injected `<user_info>` / reminders are not a turn. */
function userTurn(content: unknown): { text: string; images: ImageRef[] } | undefined {
  const raw = flatten(content);
  const images = imageRefs(raw);
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(raw);
  if (query || images.length) {
    const text = query?.[1]?.trim() ?? '';
    return text || images.length ? { text, images } : undefined;
  }
  if (
    raw.includes('<user_info>') ||
    raw.includes('<system-reminder>') ||
    raw.includes('synthetic_reason')
  ) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? { text: trimmed, images } : undefined;
}

/**
 * The skills a typed `/<skill>` loaded, as the markers that follow its prompt.
 * 1.0.70 files the expansion after the query as `<skill_information>`, whose
 * `<skills_referenced>` names each one (probe, 2026-10-29). Read past the
 * query's close so a prompt that types the tags is still prose, and from the
 * list alone: the expanded body after it is the skill's own text.
 *
 * The pipe carries only the typed words, and a model loading a skill itself
 * is a `read_file` (`cli_state/grok/probe.md`), so this file is the only
 * evidence and our record has no marker to match.
 */
function skillsInvoked(content: unknown): Marker[] {
  const raw = flatten(content);
  const close = raw.indexOf('</user_query>');
  if (close < 0) return [];
  const list = /<skill_information>\s*<skills_referenced>([\s\S]*?)<\/skills_referenced>/.exec(
    raw.slice(close)
  )?.[1];
  if (!list) return [];
  return [...list.matchAll(/<skill name="([^"]+)"/g)].flatMap(([, name]) =>
    name ? [{ mark: 'skill' as const, skill: name, by: 'you' as const }] : []
  );
}

/** Bounded output: this brand's results are plain strings. Exported for
 *  `grok/tee.ts`, which takes the same output off the wire. */
export function cutOutput(value: unknown): string | undefined {
  return typeof value === 'string' ? cut(value) : undefined;
}

function toolResults(rows: readonly Record<string, unknown>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.type !== 'tool_result' || typeof row.tool_call_id !== 'string') {
      continue;
    }
    // Presence is the pairing key. Empty content still means the call finished
    // (01a00db4 `exit: 0` is the usual; a blank result must not look pending).
    out.set(row.tool_call_id, cutOutput(row.content) ?? '');
  }
  return out;
}

/** What one assistant row's calls produced: the calls themselves, and the write
 *  pill's two halves gathered off the same pass. */
type Called = { calls: ToolCall[]; files: string[]; sizes: Record<string, Written> };

function toolCalls(
  row: Record<string, unknown>,
  results: Map<string, string>,
  cwd: string | undefined
): Called {
  const raw = Array.isArray(row.tool_calls) ? row.tool_calls : [];
  const out: ToolCall[] = [];
  const files: string[] = [];
  const sizes: Record<string, Written> = {};
  for (const call of raw) {
    if (!isRecord(call) || typeof call.name !== 'string') {
      continue;
    }
    let input: Record<string, unknown> | undefined;
    if (typeof call.arguments === 'string') {
      try {
        const parsed: unknown = JSON.parse(call.arguments);
        if (isRecord(parsed)) {
          input = parsed;
        }
      } catch {
        input = undefined;
      }
    } else if (isRecord(call.arguments)) {
      input = call.arguments;
    } else if (isRecord(call.rawInput)) {
      input = call.rawInput;
    }
    const id = typeof call.id === 'string' ? call.id : '';
    const output = id ? results.get(id) : undefined;
    const label = toolLabel(call.name);
    // Off every call in the row, not off the paired ones `authored` draws
    // below: a call with no `tool_result` is still running or blocked on a
    // permission, and a write is still a write the turn asked for. Claude's
    // reader records the path with no idea whether a result ever came.
    //
    // The turn still has to survive `authored`'s own `!text && !shown.length`
    // guard to carry these anywhere, so a row that is prose-less *and* wholly
    // unpaired draws nothing either way. What this reaches is the ordinary
    // case: a blocked write beside prose, or beside a call that did pair.
    //
    // `input` is the raw arguments — `scrubbedInput` below cuts what the row
    // shows, and a size read off that copy would under-report.
    noteWrite(files, sizes, label, input, cwd);
    out.push({
      id,
      name: label,
      // Bounded here as on the wire side. `ToolCall.input`'s contract says so,
      // and this reader was the one place that ignored it — a `Write` drew its
      // whole file off this file and a few hundred characters off the record,
      // for the same turn. Found by peer review, 2026-08-20.
      input: scrubbedInput(input),
      ...(output ? { output } : {})
    });
  }
  return { calls: out, files, sizes };
}

/**
 * API errors / usage limits are not a `chat_history.jsonl` type (observed
 * 2026-08-17, CLI 1.0.4). They land only on `_x.ai/session/update`
 * `turn_completed` `stop_reason: "error"`, with `agent_result` the copy.
 * `retry_state` failed is the live twin of the same turn and does not name
 * the prompt — pair off the preceding `user_message_chunk` `promptIndex`.
 * `updates.jsonl` `timestamp` is unix seconds; Grok user/assistant rows
 * carry no `at`, so the alarm does not either (a lone clock in an unstamped
 * thread).
 */
type CliAlarm = { promptIndex: number; text: string };

function cliAlarms(body: string): CliAlarm[] {
  let promptIndex: number | undefined;
  const out: CliAlarm[] = [];
  const seen = new Set<number>();
  for (const line of body.split('\n')) {
    if (!line) {
      continue;
    }
    // tool_call_update lines carry the whole file the tool returned.
    if (!line.includes('"user_message_chunk"') && !line.includes('"turn_completed"')) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    const update =
      isRecord(value.params) && isRecord(value.params.update) ? value.params.update : undefined;
    if (!update) {
      continue;
    }
    if (update.sessionUpdate === 'user_message_chunk') {
      const meta = isRecord(update._meta) ? update._meta : undefined;
      if (meta && typeof meta.promptIndex === 'number') {
        promptIndex = meta.promptIndex;
      }
      continue;
    }
    if (update.sessionUpdate !== 'turn_completed' || update.stop_reason !== 'error') {
      continue;
    }
    const text = typeof update.agent_result === 'string' ? update.agent_result.trim() : '';
    if (!text || promptIndex === undefined || seen.has(promptIndex)) {
      continue;
    }
    seen.add(promptIndex);
    out.push({ promptIndex, text });
  }
  return out;
}

function placeAlarms(
  exchanges: Exchange[],
  lastPos: Map<number, number>,
  alarms: readonly CliAlarm[]
): void {
  const inserts = alarms
    .map((alarm, i) => ({
      i,
      pos: (lastPos.get(alarm.promptIndex) ?? exchanges.length - 1) + 1,
      turn: {
        role: 'cli' as const,
        text: alarm.text,
        blocks: [{ text: alarm.text }]
      }
    }))
    .sort((a, b) => b.pos - a.pos || b.i - a.i);
  for (const insert of inserts) {
    exchanges.splice(insert.pos, 0, insert.turn);
  }
}

/**
 * Grok jsonl rows carry no cwd. The session dir is `encodeURIComponent` of
 * it (`grokCwdSlug`), so the file path is the only copy this reader has.
 */
function cwdOf(file: string): string | undefined {
  const encoded = path.basename(path.dirname(path.dirname(file)));
  if (!encoded) {
    return undefined;
  }
  try {
    const cwd = decodeURIComponent(encoded);
    // A temp-dir fixture is two levels deep too; its parent name is not a cwd.
    return path.isAbsolute(cwd) ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function authored(
  row: Record<string, unknown>,
  results: Map<string, string>,
  cwd: string | undefined,
  uuid: string
): Authored | undefined {
  const type = row.type;
  if (type === 'user') {
    const turn = userTurn(row.content);
    if (!turn) {
      return undefined;
    }
    // On what `userTurn` returns, never on the line: this CLI files a prompt
    // inside `<user_query>`, which the line above has just unwrapped (probe,
    // 2026-08-19). Both our own wrappers are brand-neutral, and `delivered` is
    // the seam that takes whichever of them is there off.
    const said = delivered(turn.text);
    const text = said.text;
    return {
      role: said.role,
      text,
      ...(said.from !== undefined ? { from: said.from } : {}),
      ...(text ? { blocks: [{ text }] } : {}),
      ...(turn.images.length ? { images: turn.images } : {})
    };
  }
  if (type === 'assistant') {
    const text = flatten(row.content).trim();
    const { calls, files, sizes } = toolCalls(row, results, cwd);
    // Unpaired `tool_calls` are still running or blocked on
    // `session/request_permission` (01a00db4 hang: last assistant had
    // `run_terminal_command`, no `tool_result`, dock said Ran command for 354s).
    const shown = calls.filter((call) => call.id && results.has(call.id));
    if (!text && !shown.length) {
      return undefined;
    }
    // Same lift Claude's reader does: `![alt](path)` in the reply is a chip,
    // not an `<img>` the panel CSP (`img-src data:`) refuses. `text` keeps
    // the syntax — nothing matches an echo against an assistant turn — and
    // the drawn block is the prose with the pictures named beside it.
    // An image-only reply is `blocks: []` on purpose: `ui/fold.ts` keeps the
    // turn alive on `images`, and `webview/chat.ts` draws the chips outside
    // the block loop.
    const { prose, refs } = proseImages(text, uuid, 0, cwd);
    return {
      role: 'assistant',
      text,
      blocks: [...(prose.trim() ? [{ text: prose }] : []), ...shown.map((call) => ({ call }))],
      ...(refs.length ? { images: refs } : {}),
      // Keys stay a subset of `files`: every key here was put there by the same
      // branch that pushed its path, which is the invariant `Authored.sizes`
      // states and two test files assert.
      ...(files.length ? { files } : {}),
      ...(Object.keys(sizes).length ? { sizes } : {})
    };
  }
  return undefined;
}

/**
 * The thread and the witness set, out of one walk of one pair of files.
 *
 * **Both answers together** is `CliAdapter.readWitnessed`'s contract and the
 * reason it exists: `readTranscript` beside it would be a second parse per poll
 * and a window in which the file can move between the two answers.
 *
 * `witnessed` is the `prompt_index` of every row the walk **kept**, as a string.
 * Only kept rows: an injected `<user_info>` or reminder that happens to carry an
 * index would otherwise sit in `theirs` forever, match nothing our tee stamped,
 * and pin every Grok card to the fallback. What the key is and why it is this
 * one: `docs/tasks/TASK_done_grok_record.md` § Key Decisions.
 *
 * `truncated` stays `false` — this reader has no byte window, and `drawable`'s
 * floor is 0 for Grok because of it. The user-only key would otherwise cut the
 * assistant turn sitting before the oldest prompt in a windowed read.
 */
type Parsed = {
  recent: Recent;
  witnessed: ReadonlySet<string>;
  /** What the file holds of each witnessed prompt's answer, by index. */
  answered: ReadonlyMap<string, Answered>;
};

/**
 * One prompt's answer as far as the file has it: the assistant rows drawn
 * after it, and whether an alarm was placed for it. A resume whose read
 * caught a turn partway matches that turn's rows off the pipe against these
 * (`GrokSession.admit`), by count — the tee groups rows as this file does.
 */
export type Answered = { rows: number; alarm: boolean };

const EMPTY: Parsed = {
  recent: { exchanges: [], truncated: false },
  witnessed: new Set(),
  answered: new Map()
};

/**
 * One entry per file ever read; dies with the panel, like every cache here.
 *
 * **Stamped on both files, not on `chat_history.jsonl` alone.** The alarms in
 * the thread come out of the sibling `updates.jsonl` and are exactly the events
 * that never touch the history file (README P7: an API error or a usage limit
 * is not a `chat_history.jsonl` type), so a stamp on the history alone would
 * freeze out the one kind of turn that can arrive without it. Found in
 * plan-review, 2026-08-20.
 *
 * The identity this hands back is load-bearing: `drawableFor` compares `recent`
 * and `witnessed` by reference, and `renderTranscript` skips a ~148 KB view
 * rebuild when the reading it is handed is the one it drew last.
 */
const cache = new Map<string, { stamp: string; parsed: Parsed }>();

async function stampOf(file: string): Promise<string> {
  try {
    const { size, mtimeMs } = await fs.stat(file);
    return `${size}:${mtimeMs}`;
  } catch {
    return 'none';
  }
}

async function parse(file: string): Promise<Parsed> {
  if (!file) {
    return EMPTY;
  }
  const updatesFile = path.join(path.dirname(file), 'updates.jsonl');
  const [historyStamp, updatesStamp] = await Promise.all([stampOf(file), stampOf(updatesFile)]);
  const stamp = `${historyStamp}|${updatesStamp}`;
  const hit = cache.get(file);
  if (hit?.stamp === stamp) {
    return hit.parsed;
  }
  const [history, updates] = await Promise.all([
    fs.readFile(file, 'utf8').catch(() => undefined),
    fs.readFile(updatesFile, 'utf8').catch(() => '')
  ]);
  if (history === undefined) {
    // "Not found", "empty" and "failed" are one value at this boundary, and an
    // empty set is no evidence either way — `drawable` then draws the record.
    return EMPTY;
  }
  const { recent, witnessed, answered } = walk(file, history, updates);
  const parsed = { recent, witnessed, answered };
  cache.set(file, { stamp, parsed });
  return parsed;
}

/** Both files' contents, as one reading of the conversation. */
function walk(
  file: string,
  history: string,
  updates: string
): Parsed & { order: readonly Witness[] } {
  const rows: Record<string, unknown>[] = [];
  for (const line of history.split('\n')) {
    if (!line) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(value)) {
      rows.push(value);
    }
  }
  const results = toolResults(rows);
  const exchanges: Exchange[] = [];
  const witnessed = new Set<string>();
  const answered = new Map<string, Answered>();
  /** The row each witnessed prompt is, to find again once alarms are placed. */
  const prompts = new Map<Exchange, string>();
  const lastPos = new Map<number, number>();
  let promptIndex: number | undefined;
  /** The prompt the rows being walked answer: none after a user row without
   *  an index, whose answer is no witnessed prompt's. */
  let answering: Answered | undefined;
  const cwd = cwdOf(file);
  const sessionId = path.basename(path.dirname(file));
  let assistants = 0;
  let sawWarm = false;
  for (const value of rows) {
    const turn = authored(value, results, cwd, `${sessionId}.g${assistants}`);
    if (!turn) {
      continue;
    }
    if (turn.role === 'assistant') {
      assistants += 1;
    }
    sawWarm ||= turn.role === 'warm';
    if (sawWarm && turn.role === 'assistant') turn.maintenance = false;
    exchanges.push(turn);
    // A resolved wait or a ping enters this CLI as a prompt like any other and
    // keeps its `prompt_index`, so it counts here whatever it is drawn as —
    // `grok/tee.ts` stamps `m` on it for the same reason, and the two sets are
    // compared.
    if (turn.role === 'user' || turn.role === 'wait' || turn.role === 'warm') {
      answering = undefined;
      if (typeof value.prompt_index === 'number') {
        promptIndex = value.prompt_index;
        if (!witnessed.has(String(promptIndex))) prompts.set(turn, String(promptIndex));
        witnessed.add(String(value.prompt_index));
        answering = { rows: 0, alarm: false };
        answered.set(String(value.prompt_index), answering);
      }
    } else if (turn.role === 'assistant' && answering) {
      answering.rows += 1;
    }
    if (turn.role === 'user') exchanges.push(...skillsInvoked(value.content));
    if (promptIndex !== undefined) {
      lastPos.set(promptIndex, exchanges.length - 1);
    }
  }
  const alarms = cliAlarms(updates);
  for (const alarm of alarms) {
    const of = answered.get(String(alarm.promptIndex));
    if (of) of.alarm = true;
  }
  placeAlarms(exchanges, lastPos, alarms);
  // The key is the prompt's, so its exchange opens at the prompt's own row.
  const order = exchanges.flatMap((row, from) => {
    const key = prompts.get(row);
    return key === undefined ? [] : [{ key, from }];
  });
  return { recent: { exchanges, truncated: false }, witnessed, answered, order };
}

export async function readGrokTranscript(file: string): Promise<Recent> {
  return (await parse(file)).recent;
}

/** The same walk, plus every prompt ordinal it saw — Grok's half of the
 *  comparison in `core/record.ts`'s `drawable`. */
export async function readWitnessed(file: string): Promise<Parsed> {
  return parse(file);
}

/**
 * `readWitnessed` for a reader that reads once and keeps what it read — a
 * resumed session's recovery (`core/thread.ts`). A file that is not there is
 * no history, as at the poll; **one that is there and cannot be read throws**,
 * where the poll answers empty and its next read repairs that. A recovery has
 * no next read, so an empty answer would stand for the session's life.
 * Uncached: it runs once per resumed conversation.
 */
export async function recoverWitnessed(
  file: string
): Promise<Parsed & { order: readonly Witness[] }> {
  if (!file) return { ...EMPTY, order: [] };
  const [history, updates] = await Promise.all([
    unlessMissing(file),
    unlessMissing(path.join(path.dirname(file), 'updates.jsonl'))
  ]);
  return history === undefined ? { ...EMPTY, order: [] } : walk(file, history, updates ?? '');
}

async function unlessMissing(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Platform-independent Grok fallback policy keeps correlation in the brand seam.
// Windows measurements support 3 ms early; the 2 ms late policy accounts for
// precise-clock error plus unknown echo rounding. Clock sources and
// timer-resolution limits: docs/reference/cli_state/grok/transcript.md.
const ECHO_EARLY_MS = 3;
const ECHO_LATE_MS = 2;

export function sentEchoWindow(
  sentAt: number,
  settledAt?: number
): { earliest: number; latest: number } {
  return {
    earliest: sentAt - ECHO_EARLY_MS,
    latest: settledAt === undefined ? Infinity : settledAt + ECHO_LATE_MS
  };
}

/** Grok 1.0.41 writes this prompt echo to updates.jsonl but omits it from ACP. */
export async function readSentUserUpdate(
  transcript: string,
  sentAt: number,
  text: string,
  settledAt?: number
): Promise<{ method: string; params: unknown; at: number } | undefined> {
  if (!transcript) return undefined;
  const file = path.join(path.dirname(transcript), 'updates.jsonl');
  const handle = await fs.open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const window = sentEchoWindow(sentAt, settledAt);
    let fallback: { method: string; params: unknown; at: number } | undefined;
    let fallbackKey: string | undefined;
    let ambiguous = false;
    let previousStart = size + 1;
    for (const width of [1_048_576, 8_388_608, size]) {
      const start = Math.max(0, size - width);
      if (start === previousStart) continue;
      previousStart = start;
      const buffer = Buffer.alloc(size - start);
      let read = 0;
      while (read < buffer.length) {
        const chunk = await handle.read(buffer, read, buffer.length - read, start + read);
        if (!chunk.bytesRead) break;
        read += chunk.bytesRead;
      }
      const raw = buffer.subarray(0, read).toString('utf8');
      const first = start ? raw.indexOf('\n') + 1 : 0;
      if (start && !first) continue;
      const lines = raw.slice(first).split('\n');
      for (const line of lines) {
        const candidate = sentUserUpdate(line, window, text);
        if (!candidate) continue;
        const { secondsOnly, ...echo } = candidate;
        const exactStart = secondsOnly ? Math.floor(sentAt / 1_000) * 1_000 : sentAt;
        if (echo.at >= exactStart && echo.at <= (settledAt ?? Infinity)) return echo;
        const params = isRecord(echo.params) ? echo.params : undefined;
        const update = params && isRecord(params.update) ? params.update : undefined;
        const meta = update && isRecord(update._meta) ? update._meta : undefined;
        const key =
          typeof meta?.promptIndex === 'number' ? `index:${meta.promptIndex}` : `at:${echo.at}`;
        if (!fallback) {
          fallback = echo;
          fallbackKey = key;
        } else if (key !== fallbackKey) {
          ambiguous = true;
        }
      }
      if (windowPrecedesSend(lines[0] ?? '', window.earliest)) break;
      if (!start) break;
    }
    return ambiguous ? undefined : fallback;
  } finally {
    await handle.close();
  }
}

function sentUserUpdate(
  line: string,
  window: ReturnType<typeof sentEchoWindow>,
  text: string
): { method: string; params: unknown; at: number; secondsOnly: boolean } | undefined {
  if (!line.includes('"user_message_chunk"')) return undefined;
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(row)) return undefined;
  if (row.method !== 'session/update' && row.method !== '_x.ai/session/update') return undefined;
  const params = row.params;
  const update = isRecord(params) && isRecord(params.update) ? params.update : undefined;
  if (update?.sessionUpdate !== 'user_message_chunk') return undefined;
  const meta = isRecord(params) && isRecord(params._meta) ? params._meta : undefined;
  const millis = typeof meta?.agentTimestampMs === 'number' ? meta.agentTimestampMs : undefined;
  const seconds = typeof row.timestamp === 'number' ? row.timestamp : undefined;
  if (millis === undefined && seconds === undefined) return undefined;
  if (
    millis !== undefined
      ? millis < window.earliest
      : (seconds ?? 0) < Math.floor(window.earliest / 1_000)
  ) {
    return undefined;
  }
  const at = millis ?? (seconds ?? 0) * 1_000;
  if (at > window.latest) return undefined;
  const content = update.content;
  // Trimmed both sides: the words a merged message carried end in the blank
  // line `segments` puts between messages.
  if (
    (textOf(content) ?? '').trim() !== text.trim() &&
    !(text.trim() === '' && isRecord(content) && content.type === 'image')
  ) {
    return undefined;
  }
  return { method: row.method, params, at, secondsOnly: millis === undefined };
}

function windowPrecedesSend(line: string, sentAt: number): boolean {
  // Updates are appended in time order. If this window already reaches
  // before the send, older windows cannot contain its echo.
  let oldest: unknown;
  try {
    oldest = JSON.parse(line);
  } catch {
    oldest = undefined;
  }
  if (isRecord(oldest)) {
    const params = isRecord(oldest.params) ? oldest.params : undefined;
    const meta = params && isRecord(params._meta) ? params._meta : undefined;
    const millis = meta?.agentTimestampMs;
    const seconds = oldest.timestamp;
    if (typeof millis === 'number') {
      return millis < sentAt;
    } else if (typeof seconds === 'number') {
      return (seconds + 1) * 1_000 <= sentAt;
    }
  }
  return false;
}
