/**
 * Grok's ACP notifications, in our own `Exchange` shape — the write half of
 * roadmap row 54 for the second brand.
 *
 * `claude/tee.ts`'s twin, and pure for the same reason: every rule below is a
 * reading of *Grok's* spelling of a turn, where `record.ts` stores `Exchange`
 * and knows no brand.
 *
 * **Stateful, where Claude's is not.** Claude puts one message on one frame;
 * Grok streams a turn as prose and calls across many, and `chat_history.jsonl`
 * groups them its own way: one assistant row per **batch of parallel calls**,
 * with a preceding chunk's prose on the row of the batch that follows it
 * (fixture `grok-01a019f2`, 1.0.5: 60 rows, 17 of them carrying prose). A tee
 * that wrote a line per notification — or one that held every call until the
 * next chunk, which is what the first build did — makes a record-drawn dock
 * disagree with the fallback about how many turns a conversation even had. So
 * the line is held open, and a chunk's text joins it: what closes it is a new
 * batch, the prose that follows a batch, or the turn's end. `batchOf` is where
 * the grouping rule is written down.
 */

import type { RecordLine, Returned } from '../record';
import { scrubbedInput } from '../scrub';
import { delivered } from '../coordination/send';
import { proseImages } from '../prose_images';
import {
  noteWrite,
  type AnsweredAsk,
  type Authored,
  type Block,
  type ToolCall,
  type Written
} from '../transcript';
import { isUpdateMethod, metaOf, replayed, textOf, updatePayload } from './reduce';
import { taskEndLines, type TaskEnd } from '../task_end';
import { cutOutput, toolLabel } from './transcript';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The notification's payload, or nothing for one this record does not keep.
 *
 * `reduce.ts` owns every one of these readings — the method triple, the
 * `{sessionId, update}` unwrap, and the replay drop — and this asks it rather
 * than repeating it. Two readings of one wire is how the live bubble and the
 * record come to disagree about a payload.
 *
 * **Both metas, and the outer one carries it.** Probed 2026-08-20 (1.0.5): all
 * 18 notifications of a `session/load` replay wore `isReplay` on
 * `params._meta`, and the `user_message_chunk` among them wore an
 * `update._meta` holding `modelId` and `promptIndex` with no `isReplay` beside
 * them. `replayed` tests both; `cli_state/grok/protocol.md` § Resume.
 */
function updateOf(method: string, params: unknown): Record<string, unknown> | undefined {
  if (!isUpdateMethod(method) || !isRecord(params)) {
    return undefined;
  }
  const update = updatePayload(params);
  return update && !replayed(params, update) ? update : undefined;
}

/** A chunk's text, or nothing said. `content` is one `{type,text}` object on
 *  this wire, and not always text at all — see `userTurn`. */
function chunkText(content: unknown): string {
  return textOf(content) ?? '';
}

/**
 * What a completed call returned, cut by the reader the fallback uses.
 *
 * `tool_call_update` carries it as `content: [{ type: "content", content: {
 * type: "text", text } }]` (1.0.5) or as `rawOutput`; the disk side is a
 * `tool_result` row's plain string. `cutOutput` is that side's own ceiling, so
 * a call row does not change length when the dock swaps sources.
 */
function outputOf(update: Record<string, unknown>): string | undefined {
  const content: unknown = update.content;
  const said = Array.isArray(content)
    ? (content as unknown[])
        .map(
          (part) => textOf(isRecord(part) && part.type === 'content' ? part.content : part) ?? ''
        )
        .join('')
    : (textOf(content) ?? '');
  return cutOutput(said || (textOf(update.rawOutput) ?? ''));
}

/**
 * The batch a call belongs to: `call-<uuid>-<n>` without its index.
 *
 * **This is what a disk assistant row is.** Measured on fixture
 * `grok-01a019f2` (1.0.5): 59 rows carry calls, 59 distinct uuids, and no uuid
 * is ever split across two rows or mixed with another in one. The index is a
 * counter over the whole turn (0,1 then 2,3,4 …), so it says nothing about
 * grouping — the uuid does.
 */
function batchOf(id: string): string {
  const cut = id.lastIndexOf('-');
  return cut > 0 && /^\d+$/.test(id.slice(cut + 1)) ? id.slice(0, cut) : id;
}

/**
 * The body of a `<system-reminder>` echo, or nothing for text nobody injected.
 *
 * **Grok echoes these where Claude does not**, which is the whole of why they
 * reached the record as turns: this brand's user turns come off the wire and
 * the other's come off the disk walk, whose filter has always dropped them.
 * Anchored to both ends of the trimmed text so a prompt that merely quotes the
 * tag is still a prompt.
 */
const REMINDER = /^<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>$/;

/**
 * A backgrounded task reporting that it ended, as the call it belongs to.
 *
 * Grok wakes the model with a synthetic turn when a backgrounded task exits.
 * Two grammars over the 9 notices in the records here — `Background task "<id>"
 * completed (exit code: N)` and `Monitor "<id>" ended: […]` — and both name the
 * task in the same place, so one pattern reads both and the verb is carried
 * through as the CLI wrote it.
 */
const NOTICE = /^(Background task|Monitor)\s+"([^"]+)"\s+([\s\S]+)$/;

/** The line pointing at output nothing here can go and fetch. Dropped by its
 *  opening rather than matched whole: `Monitor` ends it "for full output" where
 *  the other says "to see the full output". */
const FETCH = 'Use get_command_or_subagent_output(';

/**
 * What the notice says, keyed by the task it names.
 *
 * The id comes out of the words because the row this lands on *is* that task,
 * and it is 36 characters of uuid against `cutOutput`'s ceiling. What is left is
 * the CLI's own sentence — `ToolCall.output` is held as the CLI wrote it, and a
 * formatter per grammar would be vocabulary we invented.
 */
function noticeIn(body: string): { id: string; output: string } | undefined {
  const said = NOTICE.exec(body);
  const verb = said?.[1];
  const id = said?.[2];
  const rest = said?.[3];
  if (!verb || !id || !rest) {
    return undefined;
  }
  const kept = rest
    .split('\n')
    .filter((line) => !line.startsWith(FETCH))
    .join('\n')
    .trim();
  const output = cutOutput(`${verb} ${kept}`);
  return output ? { id, output } : undefined;
}

/**
 * The task a completed call started, by the CLI's own name for it.
 *
 * **Two spellings, and on one shape this field is the only evidence there is.**
 * Probed 2026-08-23 across every `updates.jsonl` here: a backgrounded shell call
 * completes carrying `rawOutput: {type:"BackgroundTaskStarted", task_id, …}`,
 * a monitor `rawOutput: {type:"Monitor", taskId, …}` — snake on one, camel on
 * the other. The first repeats its id in `content` as `Background task <id>
 * started`, which an earlier build read instead; the monitor's `content` is
 * `null`, so `outputOf` answered nothing, every monitor notice resolved to no
 * call, and all four here were dropped.
 *
 * `task_id` is the call's own id when the CLI backgrounded it on timeout, which
 * maps a call to itself — already what `tool_call` wrote, and harmless.
 */
function taskStarted(update: Record<string, unknown>): string | undefined {
  const raw = update.rawOutput;
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = raw.task_id ?? raw.taskId;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * A backgrounded command's end, off `_x.ai/task_completed`, before its call is
 * known. Probed 2026-10-13 (1.0.50, `cli_state/grok/background_cmd_2026_10_13`):
 * the payload is `params.update`, `sessionUpdate: 'task_completed'`, and
 * `will_wake` says whether Grok starts a turn of its own for it. Not an
 * `isUpdateMethod` method, so `updateOf` would drop it.
 *
 * Status is mapped here, once: a kill is `stopped` whatever code it left, exit
 * 0 is `completed`, any other code `failed`. No code at all states none.
 */
function taskCompleted(
  method: string,
  params: unknown
): { task: string; end: Omit<TaskEnd, 'call' | 'at'> } | undefined {
  if (method !== '_x.ai/task_completed' || !isRecord(params)) {
    return undefined;
  }
  const update = updatePayload(params);
  const snapshot = update?.task_snapshot;
  if (!update || replayed(params, update) || !isRecord(snapshot)) {
    return undefined;
  }
  const task = snapshot.task_id;
  if (typeof task !== 'string' || !task) {
    return undefined;
  }
  const code = snapshot.exit_code;
  const status =
    snapshot.explicitly_killed === true
      ? 'stopped'
      : code === 0
        ? 'completed'
        : typeof code === 'number'
          ? 'failed'
          : undefined;
  return {
    task,
    end: {
      cause: 'command',
      ...(status ? { status } : {}),
      ...(typeof snapshot.output === 'string' ? { output: snapshot.output } : {}),
      wakes: update.will_wake === true
    }
  };
}

/**
 * A subagent's end, off `_x.ai/session_notification` `subagent_finished`.
 * Probed 2026-10-14 (1.0.52, `cli_state/grok/subagent_cmd_2026_10_14`): a
 * background subagent says `will_wake: true` and a turn follows, with no
 * `task_completed`; one the turn waited on says `false`. Only `completed` was
 * seen; `failed` and `stopped` are read as stated, any other word as none.
 */
function subagentFinished(
  method: string,
  params: unknown
): { subagent: string; end: Omit<TaskEnd, 'call' | 'at'> } | undefined {
  if (method !== '_x.ai/session_notification' || !isRecord(params)) {
    return undefined;
  }
  const update = updatePayload(params);
  if (!update || update.sessionUpdate !== 'subagent_finished' || replayed(params, update)) {
    return undefined;
  }
  const subagent = update.subagent_id;
  if (typeof subagent !== 'string' || !subagent) {
    return undefined;
  }
  const status =
    update.status === 'completed' || update.status === 'failed' || update.status === 'stopped'
      ? update.status
      : undefined;
  return {
    subagent,
    end: { cause: 'agent', ...(status ? { status } : {}), wakes: update.will_wake === true }
  };
}

/** The tool's own name, mapped into the vocabulary the disk reader already
 *  speaks. `title` is a human label on some calls (`Write \`/tmp/x.txt\``) and
 *  the bare tool name on others, so `_meta["x.ai/tool"].name` goes first. */
function callName(update: Record<string, unknown>): string {
  const meta = metaOf(update);
  const tool = meta && isRecord(meta['x.ai/tool']) ? meta['x.ai/tool'] : undefined;
  const raw =
    (tool && typeof tool.name === 'string' && tool.name) ||
    (typeof update.title === 'string' && update.title) ||
    (typeof update.name === 'string' && update.name) ||
    'a tool';
  return toolLabel(raw);
}

/** Streaming prose and its landed line share one row. Other lines get their own slots. */
export type Teed =
  /** Prose growing on the open line — or, `late`, text of a model call a close
   *  already ended, for the row that close cut. Whether that row still takes
   *  it is the thread's to say (`Conversation.stream`); it opens no turn
   *  either way. */
  | {
      kind: 'stream';
      row: string;
      delta: string;
      at: number;
      late?: true;
      owner?: Pick<Authored, 'maintenance' | 'warmId'>;
    }
  /** The open line landing on its row: complete, or `cut` short by its close. */
  | { kind: 'close'; row: string; line: Authored; cut: boolean }
  /** The last closer of the turn has spoken: its cut line or alarm is final. */
  | { kind: 'seal'; row: string }
  /** The echo of the prompt the drain sent (`sent`): that prompt's witness,
   *  not a turn of its own. */
  | { kind: 'echo'; line: RecordLine }
  /** The turn's alarm, which a later closer of that turn may restate on the
   *  same row until it is sealed. */
  | { kind: 'alarm'; row: string; line: Authored }
  | { kind: 'line'; line: RecordLine };

/**
 * One of the turn's closers: `turn_completed`, `prompt_complete`, the
 * `session/prompt` reply — or Send now, the child's exit and the reader's stop,
 * which close the open output without a prompt-matching constraint (`cut`).
 */
export type Close = {
  /** The prompt the closer names. A line another prompt's chunks opened is
   *  not this closer's to end. */
  turn?: string;
  /** Send now can supersede a queued prompt and a running wake with different
   *  ids. Both own one divider; neither restricts which output is flushed. */
  interrupted?: readonly string[];
  /** Grok's word for how the turn ended: `stop_reason` / `stopReason`. */
  stop?: unknown;
  /** What Grok said about it: `agent_result`, or the reply's error. */
  said?: string;
  /** The turn did not complete, whatever `stop` says. */
  cut?: boolean;
  /** No closer of this turn follows, so its cut line may be written. */
  last?: boolean;
};

/**
 * What the dock says for an ending Grok gave no words for — a reply-only close
 * carries a stop word and no `agent_result`.
 */
const ALARM: Readonly<Record<string, string>> = {
  error: 'The turn ended with an error.',
  rate_limit: 'The turn stopped at a rate limit.'
};

/**
 * One conversation's notifications, as the lines of its record and the rows
 * of its thread.
 *
 * Held per session by `GrokSession`. `teed` and the closers answer what each
 * notification does to the thread, in order; `take` and `endTurn` answer the
 * record's lines alone. An empty array is the ordinary case.
 */
export class GrokTee {
  /**
   * `cwd` is what a relative `![alt](out/a.png)` resolves against — Grok's
   * jsonl rows do not carry one, and this process does. `sessionId` is the
   * other half of the `f|` uuid: the panel's fetch cache is keyed by id for
   * the life of the webview, so two sessions (or a resume) minting `t0` for
   * the same overwritten path would share one chip's bytes.
   */
  constructor(
    private readonly cwd: string = '',
    private sessionId = ''
  ) {}

  /**
   * The prompt a drain just wrote, by how its echo reads (`GrokSession`'s
   * `echoes`), or none once its turn has ended. Its echo is taken once, as an
   * `echo`, and closes only a line opened before the prompt went — a turn
   * whose close was lost — never the reply it may arrive in the middle of.
   */
  sent(echoes: ((line: RecordLine) => boolean) | undefined): void {
    this.sending = echoes ? { echoes, from: this.rows } : undefined;
  }

  /** Handshake mints the id after construction; a resume already had one. */
  bindSession(sessionId: string): void {
    if (sessionId) {
      this.sessionId = sessionId;
    }
  }

  /** The assistant turn being built: the prose streamed so far, the calls that
   *  followed it, and the batch those calls belong to. `at` is when the *first*
   *  chunk of it arrived, since that is when the turn began. Flushed by a new
   *  batch, by a chunk arriving after calls or from another model call, or by
   *  the turn's end. `row` is its entry in the thread; `stream` and `prompt`
   *  are the model call and the prompt its frames named. */
  private open:
    | {
        row: string;
        text: string;
        calls: ToolCall[];
        files: string[];
        sizes: Record<string, Written>;
        batch?: string;
        stream?: number;
        prompt?: string;
        at: number;
        /** Its place among the lines this tee opened. */
        seq: number;
        owner?: Pick<Authored, 'maintenance' | 'warmId'>;
      }
    | undefined;
  private rows = 0;
  /**
   * The lines closes cut, by the model call that wrote each, oldest first.
   *
   * **Kept past the close, because the stream outlives it.** Grok's cancelled
   * stream (1.0.46) put a chunk after `turn_completed`: same `streamStartMs`,
   * an older `eventId`, no `promptId`. Measured 2026-10-08: the chunk followed
   * by 1 ms, all three closers within 2 ms on one stdout
   * (`cli_state/grok/protocol.md`). That text
   * belongs to the row the close ended, never to a line of its own — and
   * another prompt's line may be streaming by then (Send now), which it must
   * not close. Its text goes to that row however late, sealed or not, and
   * never reads as a new model call: the thread keeps the deadline and says
   * whether the row still takes it. `sealed` is only whether the turn's last
   * closer has said so already. `CLOSED_MAX` of them.
   */
  private readonly ended = new Map<number, { row: string; turn?: string; sealed?: true }>();
  /** The prompt the drain sent and whose echo has not come (`sent`). */
  private sending: { echoes: (line: RecordLine) => boolean; from: number } | undefined;
  /** Each turn's one alarm, by the prompt its closers name, newest last, so it
   *  is said once however many closers state it — a stale one included. 16 for
   *  `sentPrompts`' reason (`GrokSession`); `''` is a closer that named none. */
  private readonly alarms = new Map<
    string,
    { row: string; words: boolean; at: number; sealed?: true }
  >();
  private alarmRows = 0;
  private readonly interrupted = new Map<string, true>();
  /** The words the latest turn's closers carried, for a closer with none. */
  private said: { turn: string; text: string } | undefined;
  /** The open line's calls by id, so a result that arrives while that line is
   *  still open fills the call in place rather than becoming a `{ret}`. */
  private openCalls = new Map<string, ToolCall>();
  /**
   * Which call to fold a task notice onto, keyed by every id that can name one
   * — the call's own, and the task id a `background: true` run or a monitor
   * minted for it (`taskStarted`).
   *
   * **Not `openCalls`, and that is the point.** `flush()` empties that map at
   * the end of every turn, and a notice lands minutes and many turns after the
   * call it belongs to. A call maps to itself so that one lookup answers both
   * "which call" and "is this a task this record ever saw" — a notice whose
   * call sat outside our window resolves to nothing. A reminder for one is
   * dropped; a `task_completed` that wakes is marked with no call
   * (`endedElsewhereWakes`).
   */
  private readonly callFor = new Map<string, string>();
  /** Calls whose end is already on the record, so an older build's reminder
   *  for the same end adds nothing. */
  private readonly endedCalls = new Set<string>();
  /** Ends written with no call here — a handed-over command's task, or a
   *  subagent — so a repeat of one marks no second turn. */
  private readonly endedElsewhere = new Set<string>();

  /** How many assistant lines this tee has flushed. The `f|` uuid, since Grok
   *  writes no entry id and two renders of one path must not share a cache key. */
  private flushed = 0;
  private readonly seenPromptIndexes = new Set<string>();

  /** The disk-only echo has the same shape as the live one, but must not flush
   * an assistant line that arrived while its file was being read. */
  recoveredUser(method: string, params: unknown, at: number): RecordLine | undefined {
    const update = updateOf(method, params);
    return update?.sessionUpdate === 'user_message_chunk'
      ? this.userTurn(update, at)[0]
      : undefined;
  }

  /** The caller supplies arrival time so a tee can run against recorded fixtures. */
  teed(
    method: string,
    params: unknown,
    at: number,
    historical = false,
    owner?: Pick<Authored, 'maintenance' | 'warmId'>
  ): Teed[] {
    if (method === '_x.ai/session/prompt_complete' && isRecord(params)) {
      // A closer of ours that `eventsFrom` does not read: it names the prompt
      // and carries `agentResult`, which the reply to that prompt does not.
      return this.closeTurn(
        {
          turn: typeof params.promptId === 'string' ? params.promptId : undefined,
          stop: params.stopReason,
          said: textOf(params.agentResult)
        },
        at,
        historical
      );
    }
    const completed = taskCompleted(method, params);
    if (completed) {
      return this.taskEnded(completed.task, completed.end, at);
    }
    const finished = subagentFinished(method, params);
    if (finished) {
      return this.endedElsewhereWakes(`agent:${finished.subagent}`, finished.end, at);
    }
    const update = updateOf(method, params);
    if (!update) {
      return [];
    }
    const kind = update.sessionUpdate;
    const meta = isRecord(params) ? metaOf(params) : undefined;
    const stream = typeof meta?.streamStartMs === 'number' ? meta.streamStartMs : undefined;
    const prompt = typeof meta?.promptId === 'string' ? meta.promptId : undefined;
    if (kind === 'user_message_chunk') {
      return this.userUpdate(update, at, historical);
    }
    if (kind === 'agent_message_chunk') {
      return this.textUpdate(update, at, historical, stream, prompt, owner);
    }
    if (kind === 'tool_call') {
      return this.toolCall(update, at, historical, stream, prompt, owner);
    }
    if (kind === 'tool_call_update') {
      return this.returned(update).map(asLine);
    }
    if (kind === 'turn_completed') {
      return this.closeTurn(
        {
          turn: typeof update.prompt_id === 'string' ? update.prompt_id : undefined,
          stop: update.stop_reason,
          said: textOf(update.agent_result)
        },
        at,
        historical
      );
    }
    return [];
  }

  private userUpdate(update: Record<string, unknown>, at: number, historical: boolean): Teed[] {
    const said = this.userTurn(update, at);
    // An admitted historical ping is already recorded; its echo cannot witness the current send.
    if (historical) return said.filter((line) => !('role' in line)).map(asLine);
    // A prompt begins a turn, whose closers have not spoken yet. A task's
    // notice rides this update too, and begins nothing.
    const out = said.some((line) => 'role' in line) ? this.unnamed() : [];
    const sending = this.sending;
    const echo = sending && said.find((line) => sending.echoes(line));
    if (!sending || !echo) {
      // Another turn's prompt: the open assistant line lands first, as the
      // file orders it.
      return [...this.flush(false), ...out, ...said.map(asLine)];
    }
    // Ours, which can come after its reply has begun: that line stays open,
    // and the echo goes to the slot the drain took ahead of it.
    this.sending = undefined;
    const lost = this.open && this.open.seq < sending.from ? this.flush(false) : [];
    return [
      ...lost,
      ...out,
      ...said.map((line): Teed => (line === echo ? { kind: 'echo', line } : asLine(line)))
    ];
  }

  private textUpdate(
    update: Record<string, unknown>,
    at: number,
    historical: boolean,
    stream: number | undefined,
    prompt: string | undefined,
    owner?: Pick<Authored, 'maintenance' | 'warmId'>
  ): Teed[] {
    const text = chunkText(update.content);
    if (!text) {
      return [];
    }
    const ended = stream !== undefined && this.open?.stream !== stream && this.ended.get(stream);
    if (ended) return [{ kind: 'stream', row: ended.row, delta: text, at, late: true }];
    if (historical) return [asLine({ role: 'assistant', text, blocks: [{ text }], at })];
    // **A chunk is a token delta, so it appends.** Measured 2026-08-22
    // (grok-4.6, session `01a02588`): a 68-character reply came as 14 chunks
    // of a word or two, and opening a line per chunk wrote 44 assistant rows
    // where `chat_history.jsonl` wrote 4 — the dock drew a column of one-word
    // turns (`cli_state/grok/protocol.md` § A chunk is a token).
    //
    // **A line already carrying calls is closed first**, which is what keeps
    // the agreement `batchOf` below is for: a disk assistant row is prose plus
    // one batch, so the prose after a batch belongs to the row after it. That
    // same reply, both records — `I'll run …` rides the call it made, `Exit
    // code: **0**` is the turn after.
    //
    // **So is a line another model call wrote.** A wake whose close was lost
    // leaves its prose open, and our reply after it would join the wake's
    // row — the echo of our prompt cannot close it when Grok writes that echo
    // only to disk (1.0.41), and the poll that finds it lands seconds after
    // the reply has begun. One call's prose never continues another's.
    const out = this.open?.calls.length || this.otherCall(stream) ? this.flush(false) : [];
    const open = this.open ?? this.opening(out, at, stream, prompt, owner);
    open.text += text;
    out.push({
      kind: 'stream',
      row: open.row,
      delta: text,
      at,
      ...(open.owner ? { owner: open.owner } : {})
    });
    return out;
  }

  private toolCall(
    update: Record<string, unknown>,
    at: number,
    historical: boolean,
    stream: number | undefined,
    prompt: string | undefined,
    owner?: Pick<Authored, 'maintenance' | 'warmId'>
  ): Teed[] {
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    const call: ToolCall = { id, name: callName(update) };
    const input = scrubbedInput(update.rawInput);
    if (input) call.input = input;
    if (historical) {
      const files: string[] = [];
      const sizes: Record<string, Written> = {};
      noteWrite(
        files,
        sizes,
        call.name,
        isRecord(update.rawInput) ? update.rawInput : undefined,
        this.cwd || undefined
      );
      return [
        asLine({
          role: 'assistant',
          text: '',
          blocks: [{ call }],
          at,
          ...(files.length ? { files, sizes } : {})
        })
      ];
    }
    const batch = batchOf(id);
    // **A new batch is a new row**, which is the whole of how this file
    // agrees with `chat_history.jsonl` on where a turn ends. The CLI writes
    // one assistant row per batch of parallel calls; a tee that piled every
    // call on the last chunk drew 17 turns where the fallback drew 60, on
    // this fixture's own conversation. Peer review of 2026-08-20, measured.
    // `!== undefined`, not truthiness: `batchOf('')` is `''`, and read as
    // "no batch yet" it would let a call the CLI named nothing hold the line
    // open across every real batch after it. Off the observed wire — every id
    // here is `call-<uuid>-<n>` — and one character either way.
    const openBatch = this.open?.batch;
    const out =
      (openBatch !== undefined && openBatch !== batch) || this.otherCall(stream)
        ? this.flush(false)
        : [];
    // A batch that follows no prose is an assistant row with an empty `text`
    // on disk (43 of that fixture's 60), and is one here.
    const open = this.open ?? this.opening(out, at, stream, prompt, owner);
    open.batch ??= batch;
    noteWrite(
      open.files,
      open.sizes,
      call.name,
      isRecord(update.rawInput) ? update.rawInput : undefined,
      this.cwd || undefined
    );
    open.calls.push(call);
    if (id) {
      this.openCalls.set(id, call);
      this.callFor.set(id, id);
    }
    return out;
  }

  /**
   * A finished call, either filled into the line still open or appended as a
   * `{ret}` for one already written.
   *
   * **The branch is the whole of why this class holds `openCalls`.** `readRecord`
   * folds a `ret` by looking its id up among the calls it has *already walked*,
   * so a `{ret}` line written before its call's line is dropped for good — and
   * `tool_call_update` completed almost always arrives before the next chunk
   * flushes the line the call sits on. Found in plan-review, 2026-08-20; the
   * Claude tee has no such trap because a `tool_use` rides its own frame.
   */
  private returned(update: Record<string, unknown>): RecordLine[] {
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    const status = update.status;
    if (!id || (status !== 'completed' && status !== 'failed')) {
      return [];
    }
    const output = outputOf(update);
    // Before either branch, and off the update rather than off `output`: the
    // pairing is a fact about the call whether or not its line is still open,
    // the notice that needs it arrives long after both have been decided, and a
    // monitor completes with no output at all for it to have been read from.
    const started = taskStarted(update);
    if (started) {
      this.callFor.set(started, id);
    }
    const open = this.openCalls.get(id);
    if (open) {
      if (output !== undefined) {
        open.output = output;
      }
      if (status === 'failed') {
        open.failed = true;
      }
      return [];
    }
    const ret: Returned = { id };
    if (output !== undefined) {
      ret.output = output;
    }
    if (status === 'failed') {
      ret.failed = true;
    }
    return [{ ret: [ret] }];
  }

  /**
   * A backgrounded command's end, onto the call that started it.
   *
   * **The call may still be open.** `callFor` is seeded while its line is
   * unflushed, and `readRecord` drops a `{ret}` written before its call — the
   * trap `returned()` exists for. An end that starts no turn fills the open
   * call in place. One that wakes flushes whatever line is open first, as an
   * echo does: that work belongs to the turn before the trigger, whichever
   * call it holds.
   */
  private taskEnded(task: string, end: Omit<TaskEnd, 'call' | 'at'>, at: number): Teed[] {
    const call = this.callFor.get(task);
    if (!call) {
      return this.endedElsewhereWakes(`task:${task}`, end, at);
    }
    if (this.endedCalls.has(call)) {
      return [];
    }
    this.endedCalls.add(call);
    // Marked already while its call was unknown: the repeat lands the output
    // and starts no second turn.
    const wakes = end.wakes && !this.endedElsewhere.has(`task:${task}`);
    const lines = taskEndLines({ ...end, wakes, call, at });
    if (wakes) {
      return [...this.flush(false), ...lines.map(asLine)];
    }
    const open = this.openCalls.get(call);
    if (!open) {
      return lines.map(asLine);
    }
    const [ret] = lines;
    const output = ret && 'ret' in ret ? ret.ret[0]?.output : undefined;
    if (output !== undefined) {
      open.output = output;
    }
    return [];
  }

  /**
   * An end whose call is not in this conversation, as a trigger alone. A
   * subagent's command handed to this session at the subagent's end, or the
   * subagent itself: both start a turn here (`cli_state/grok/protocol.md`,
   * *A subagent's background work*), and neither has a row here to land on.
   * One that wakes flushes the open line first, as a known call's does.
   */
  private endedElsewhereWakes(key: string, end: Omit<TaskEnd, 'call' | 'at'>, at: number): Teed[] {
    if (!end.wakes || this.endedElsewhere.has(key)) {
      return [];
    }
    this.endedElsewhere.add(key);
    return [...this.flush(false), ...taskEndLines({ ...end, at }).map(asLine)];
  }

  /**
   * What an ask answered, filed against the call it rode in on.
   *
   * **Through here rather than straight into the queue**, and for the reason
   * `returned()` exists: an ask *is* a tool call on this wire — the model emits
   * the `tool_call` and ACP raises `_x.ai/ask_user_question` for it
   * (`cli_state/grok/protocol.md`) — so at the moment the reader answers, the
   * line carrying that call is still open. A `{ret}` written then names a call
   * `readRecord` has not walked yet and is dropped by the fold, silently. Both
   * plan-review and the peer review of 2026-08-20 found the first build doing
   * exactly that.
   */
  answered(id: string, ask: AnsweredAsk): RecordLine[] {
    const open = this.openCalls.get(id);
    if (open) {
      open.ask = ask;
      return [];
    }
    return [{ ret: [{ id, ask }] }];
  }

  /**
   * The turn the CLI just echoed back, as the reader's own.
   *
   * Older Grok builds send this on ACP. Grok 1.0.41 writes it only to
   * `updates.jsonl`, so the session recovers it through `recoveredUser`.
   * Either way, `promptIndex` is the witness `drawable` weighs against
   * `chat_history.jsonl`'s `prompt_index`.
   *
   * For a prompt `GrokSession` sent, this turn is the witness and not the
   * content: the session swaps it for the row it sent (`sentInPlaceOf`), the
   * pictures' copies included, inside its append queue, where waiting is free.
   */
  private userTurn(update: Record<string, unknown>, at: number): RecordLine[] {
    const raw = chunkText(update.content);
    // **An injected reminder is never a turn**, whatever else it is. It resolves
    // to the call it reports on, or it is dropped — and one rule covers both the
    // notice whose call sat outside this record and the reminder that is not a
    // notice at all. The ordinal goes with it: a bare `{m}` would resolve to the
    // *next* turn, and dropping it is safe in the only direction that is
    // checked, since the disk walk already refuses these rows a witness.
    const body = REMINDER.exec(raw.trim())?.[1];
    if (body !== undefined) {
      const notice = noticeIn(body);
      const id = notice && this.callFor.get(notice.id);
      if (id && this.endedCalls.has(id)) {
        return [];
      }
      // `failed` is never set from one of these. That flag means the result
      // carried `is_error`; a dev server exiting 143 is the task manager killing
      // it, and a red row would report the ordinary case as a fault.
      return id && notice ? [{ ret: [{ id, output: notice.output }] }] : [];
    }
    const index = metaOf(update)?.promptIndex;
    const ordinal = typeof index === 'number' ? String(index) : undefined;
    if (ordinal && this.seenPromptIndexes.has(ordinal)) {
      return [];
    }
    // **An echo with no text is still a turn, if it names its ordinal.** A
    // prompt of nothing but a picture echoes `{type:"image",…}` and no text
    // (probed 2026-08-20, 1.0.5) while the disk row for it keeps its
    // `prompt_index`. Dropped here, that ordinal would be in `theirs` and never
    // in ours, and the card would fall back for the rest of the conversation —
    // and the pictures the drain copied would go with it.
    if (!raw && !ordinal) {
      return [];
    }
    if (ordinal) this.seenPromptIndexes.add(ordinal);
    // Both wrappers come off here — `delivered` is the same reading the disk
    // walk makes on the same text. Trimmed, because the disk walk trims what it
    // takes out of `<user_query>` — untrimmed here, the same prompt reads
    // differently on the two sources.
    const said = delivered(raw);
    const text = said.text.trim();
    const turn: Authored = {
      role: said.role,
      text,
      at,
      // The dock paints `blocks` and has no fallback (`session_io.ts` maps
      // `x.blocks ?? []`), so a turn carrying only `text` draws a YOU label
      // over an empty body. Both filled here as on both readers.
      ...(text ? { blocks: [{ text }] } : {}),
      ...(said.from !== undefined ? { from: said.from } : {})
    };
    // **On the turn's own line, never as a bare `{m}` after it.** A witness
    // line resolves to the *next* turn's index, which is `24ca63d` with the
    // names swapped: this key is user-only, so the cut would take the
    // assistant turn before it. Key Decisions in the task file.
    return [ordinal ? { ...turn, m: ordinal } : turn];
  }

  /**
   * A closer of the turn: its open line lands, cut short unless the turn
   * completed, and an alarm the turn's ending carries is said once.
   *
   * **Idempotent, because Grok closes a turn up to three times** — the
   * `turn_completed` notification, `prompt_complete` for a prompt of ours, and
   * the reply to `session/prompt` — and a turn Grok started itself, or one
   * whose notification was lost, has only some of them
   * (`GrokSession.tryDrain`). Send now, the child's exit and the reader's stop
   * are closers too. Whichever comes first lands the line; the rest find
   * nothing open. Cancellation records one divider across those closers.
   *
   * A line whose frames named another prompt stays open: a late close of turn
   * A arriving while B streams is not B's end.
   */
  closeTurn(close: Close, at: number, historical = false): Teed[] {
    const open = this.open;
    const out: Teed[] = [];
    const matches =
      !open || !close.turn || (!historical && !open.prompt) || open.prompt === close.turn;
    if (open && matches) {
      const cut = close.cut === true || stopped(close.stop);
      out.push(...this.flush(cut));
      if (cut && out.length && open.stream !== undefined) {
        const turn = open.prompt ?? close.turn;
        this.ended.set(open.stream, { row: open.row, ...(turn ? { turn } : {}) });
        bound(this.ended, CLOSED_MAX);
      }
    }
    out.push(...this.alarm(close, at));
    const turn = close.turn ?? open?.prompt ?? '';
    const interrupted = close.interrupted ?? (matches && close.stop === 'cancelled' ? [turn] : []);
    const marked = interrupted.every((id) => this.interrupted.has(id));
    for (const id of interrupted) this.interrupted.set(id, true);
    bound(this.interrupted, CLOSED_MAX);
    if (interrupted.length && !marked) out.push(asLine({ mark: 'break' }));
    if (close.last) out.push(...this.sealTurn(close.turn));
    return out;
  }

  /** The turn's last closer has spoken: a line its close cut takes no more
   *  late text, and its alarm says no more. A turn with no such closer — a
   *  wake has no reply — is sealed by the thread's own deadline. */
  sealTurn(turn: string | undefined): Teed[] {
    const ours = (of: string | undefined) => !turn || !of || of === turn;
    const out: Teed[] = [];
    for (const ended of this.ended.values()) {
      if (ended.sealed || !ours(ended.turn)) continue;
      ended.sealed = true;
      out.push({ kind: 'seal', row: ended.row });
    }
    for (const [of, alarm] of this.alarms) {
      if (alarm.sealed || !ours(of)) continue;
      alarm.sealed = true;
      out.push({ kind: 'seal', row: alarm.row });
    }
    return out;
  }

  /**
   * **The alarm is teed, not left to the fallback.** An API error or a usage
   * limit is not a `chat_history.jsonl` type at all (README P7): the disk side
   * reconstructs it from `updates.jsonl` and `placeAlarms` puts it in the
   * thread. A record drawn instead of that file would simply not have it, so a
   * turn the reader needs most would vanish on the source swap. Same shape
   * `placeAlarms` mints.
   *
   * Said by whichever closer first states `error` or `rate_limit` — the card's
   * failed turn (`outcomeOf`), so the dock agrees with the card on the
   * reply-only path too — in the CLI's own words where any closer of the turn
   * carried them. **A closer after the first can still bring those words**:
   * `turn_completed` can state the error bare and `prompt_complete` explain
   * it, so the alarm is a row of its own the next closer restates, once,
   * until the last closer seals it (`sealTurn`).
   */
  private alarm(close: Close, at: number): Teed[] {
    const turn = close.turn ?? '';
    const said = close.said?.trim();
    if (said && this.said?.turn !== turn) this.said = { turn, text: said };
    const words = this.said?.turn === turn ? this.said.text : undefined;
    const alarm = this.alarms.get(turn);
    if (alarm) {
      if (alarm.sealed || alarm.words || words === undefined) return [];
      alarm.words = true;
      return [{ kind: 'alarm', row: alarm.row, line: cliLine(words, alarm.at) }];
    }
    const fallback = typeof close.stop === 'string' ? ALARM[close.stop] : undefined;
    if (fallback === undefined) return [];
    const row = `alarm:${this.alarmRows++}`;
    const text = words ?? fallback;
    this.alarms.set(turn, { row, words: words !== undefined, at });
    bound(this.alarms, 16);
    return [{ kind: 'alarm', row, line: cliLine(text, at) }];
  }

  /** A closer that names no turn can only be about the latest one: a turn
   *  beginning ends the last one's, and says it may be written. */
  private unnamed(): Teed[] {
    this.interrupted.delete('');
    const alarm = this.alarms.get('');
    if (!alarm) return [];
    this.alarms.delete('');
    return alarm.sealed ? [] : [{ kind: 'seal', row: alarm.row }];
  }

  private opening(
    out: Teed[],
    at: number,
    stream: number | undefined,
    prompt: string | undefined,
    owner?: Pick<Authored, 'maintenance' | 'warmId'>
  ): NonNullable<GrokTee['open']> {
    out.push(...this.unnamed());
    const seq = this.rows++;
    this.open = {
      row: `line:${seq}`,
      owner,
      seq,
      text: '',
      calls: [],
      files: [],
      sizes: {},
      at,
      ...(stream !== undefined ? { stream } : {}),
      ...(prompt !== undefined ? { prompt } : {})
    };
    return this.open;
  }

  private otherCall(stream: number | undefined): boolean {
    const open = this.open?.stream;
    return stream !== undefined && open !== undefined && open !== stream;
  }

  private flush(cut: boolean): Teed[] {
    const open = this.open;
    this.open = undefined;
    this.openCalls.clear();
    if (!open || (!open.text && !open.calls.length)) {
      return [];
    }
    const who = this.sessionId || 'local';
    const { prose, refs } = proseImages(
      open.text,
      `${who}.t${this.flushed}.${open.at}`,
      0,
      this.cwd
    );
    this.flushed += 1;
    const blocks: Block[] = [
      ...(prose.trim() ? [{ text: prose }] : []),
      ...open.calls.map((call) => ({ call }))
    ];
    // **Stamped, though the Grok disk reader mints no clock.** An earlier pass
    // left these bare so a record-drawn card would not grow clocks and fold
    // measurements the fallback lacks — a parity argument, and parity is not
    // what this store is for: it exists to be richer than the file it replaces,
    // and when we saw a turn is something only we know. The bounds that *are*
    // aligned (`MAX_OUTPUT`, `core/scrub.ts`) are aligned because they exist to
    // cap cost, not to match.
    const line: Authored = {
      role: 'assistant',
      ...open.owner,
      text: open.text,
      blocks,
      at: open.at,
      ...(open.files.length ? { files: open.files } : {}),
      ...(Object.keys(open.sizes).length ? { sizes: open.sizes } : {}),
      ...(refs.length ? { images: refs } : {})
    };
    return [{ kind: 'close', row: open.row, line, cut }];
  }
}

/** How many cut model calls the tee remembers. One is unsealed at a time
 *  in practice — Send now's cut beside the next prompt's line is the most
 *  measured — so this bounds a session's life, not an expected count. */
const CLOSED_MAX = 16;

function bound<K, V>(map: Map<K, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) return;
    map.delete(key);
  }
}

function cliLine(text: string, at: number): Authored {
  return { role: 'cli', text, blocks: [{ text }], at };
}

/** A stop word that is not a completion: cancelled, an error, a rate limit,
 *  the agent process gone. No word states nothing, and is not a cut. */
function stopped(stop: unknown): boolean {
  return typeof stop === 'string' && stop !== 'end_turn';
}

export function linesOf(teed: readonly Teed[]): RecordLine[] {
  return teed.flatMap((op) =>
    op.kind === 'line' || op.kind === 'close' || op.kind === 'echo' || op.kind === 'alarm'
      ? [op.line]
      : []
  );
}

function asLine(line: RecordLine): Teed {
  return { kind: 'line', line };
}
