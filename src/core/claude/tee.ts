/**
 * Frames on the wire, in our own `Exchange` shape — the write half of roadmap
 * row 54's record.
 *
 * Pure, and here rather than in `core/record.ts` because every rule below is a
 * reading of *Claude's* spelling of a turn. `record.ts` stores `Exchange` and
 * knows no brand; Grok's own of these is `core/grok/tee.ts`.
 *
 * **Everything it needs is on the frame**, except `cwd` and the session's
 * `ClaudeTasks` — see `lineForFrame`. The earlier draft latched a `turnKind` on the session from the drain and
 * nothing ever reset it, so an `assistant` frame arriving outside a drained
 * turn was filed as a command answer for the rest of the session.
 */

import type { RecordLine, Returned } from '../record';
import { sentTurns } from '../coordination/send';
import type { QueuedMessage } from '../live';
import { proseImages } from '../prose_images';
import {
  localReply,
  noteWrite,
  type Authored,
  type Block,
  type Exchange,
  type Marker,
  type ToolCall,
  type Written
} from '../transcript';
import { scrubbedInput } from '../scrub';
import { taskEndLines, type TaskEnd } from '../task_end';
import { narrationText } from './narration';
import { outputOf } from './transcript';

/**
 * What the CLI puts where a model id goes when it answered a local command
 * itself — `/effort`, `/model`, `/context`.
 *
 * Verified on the pipe 2026-08-19 (row 54, Step 4): a local command's answer
 * came back as an ordinary `assistant` frame with `message.model` of
 * `<synthetic>`, where the two real turns beside it carried `claude-opus-5`.
 * `cli_state/claude/commands.md` § *Every local command answers in text*
 * records the same marker, and pairs it with the `result`'s `num_turns: 0`.
 *
 * On disk the same answer is a `system`/`local_command` entry, which
 * `core/claude/transcript.ts` draws as `role: 'cli', local: true` — the CLI
 * writing where the model's turn would be. So a tee that trusted
 * `type: 'assistant'` would file the CLI's own confirmation as model output.
 */
const SYNTHETIC = '<synthetic>';

/** Only the fields this file reads, all `unknown`: another program wrote them. */
type RawFrame = {
  type?: unknown;
  subtype?: unknown;
  isReplay?: unknown;
  tool_use_id?: unknown;
  status?: unknown;
  summary?: unknown;
  parent_tool_use_id?: unknown;
  task_id?: unknown;
  task_type?: unknown;
  is_backgrounded?: unknown;
  owned_by_subagent?: unknown;
  parent_task_id?: unknown;
  message?: { content?: unknown; model?: unknown; id?: unknown };
};

type RawBlock = {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  signature?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
};

/**
 * One line off the pipe as the lines of the record it becomes — empty for a
 * frame the record does not keep.
 *
 * A list rather than a single line because a turn can carry a chip as well as
 * itself: see `skillChips`. `core/grok/tee.ts` already answers in lists for its
 * own reasons, so the two sides of the seam now agree on the shape.
 *
 * Most frames are nothing: `stream_event` is the partial tail of a message that
 * arrives whole a moment later, `system` is the CLI talking about itself, and
 * a successful `result` only says the turn ended. An interrupted `result` is
 * one exception and a background command's end the other — see below. What is
 * kept is what a reader would see.
 *
 * `at` is stamped here rather than carried: the wire puts no timestamp on a
 * frame, and the dock draws a clock and measures a fold from `Authored.at`. This
 * is when the line reached us, where the `.jsonl`'s is when the CLI wrote the
 * entry — within a poll of each other, and the honest reading of what we saw.
 *
 * `cwd` is the process directory at the frame, what the disk reader takes from
 * `entry.cwd`. Absent, a relative dest degrades to a link rather than a chip
 * that would open some other file (`proseImages`).
 *
 * `tasks` is the session's memory of which tasks it started, read and never
 * written here. Absent, no task end is known, so none is recorded.
 */
export function lineForFrame(
  value: unknown,
  at: number,
  cwd?: string,
  tasks?: ClaudeTasks
): RecordLine[] {
  // `null` is a line that parses, and the tee reads the raw value rather than
  // `readFrame`'s narrowed answer — so this is reachable from the wire.
  if (!value || typeof value !== 'object') {
    return [];
  }
  const frame = value as RawFrame;
  if (frame.isReplay === true) {
    // `set_model` and `/compact` each answer with a `<local-command-stdout>`
    // echo wearing this flag. The tee runs upstream of `core/live.ts`'s guard,
    // so it makes the same call for itself.
    return [];
  }
  if (typeof frame.parent_tool_use_id === 'string') {
    // A subagent's frame, riding the parent's pipe. The CLI files these in a
    // file of their own (`projects/<slug>/<id>/subagents/`) and the transcript
    // walk drops them from the parent's thread on `isSidechain`, so recording
    // them here would put turns in this conversation that no reader of the
    // `.jsonl` ever sees.
    return [];
  }
  if (frame.type === 'result' && frame.subtype === 'error_during_execution') {
    // The CLI writes `[Request interrupted by user]` as an ordinary user entry
    // on disk and never on the pipe (`cli_state/claude/transcript.md`). This
    // subtype is the pipe's spelling of the same fact (`frames.ts` ResultFrame)
    // and the disk walk mints `{mark:'break'}` from the text. Recording it here
    // is what lets an interrupted turn match what the dock draws.
    return [{ mark: 'break' }];
  }
  if (frame.type === 'system' && frame.subtype === 'task_notification') {
    const end = backgroundEnd(frame, at, tasks);
    return end ? taskEndLines(end) : [];
  }
  if (frame.type === 'user') {
    // A `user` frame is never a prompt — the CLI does not echo what the reader
    // typed, which is why the drain synthesises it below. What it carries is
    // the answers to calls an `assistant` frame already made, which land on a
    // line of their own because the two arrive whole turns apart.
    const ret = returnedIn(frame.message?.content);
    return ret.length ? [{ ret }] : [];
  }
  if (frame.type !== 'assistant') {
    return [];
  }

  // Every `assistant` frame the CLI writes down carries one — verified on the
  // wire 2026-08-20 and on 5175 of 5175 assistant entries on disk — and the
  // split thinking/text frames of one message share it. It is the only thing
  // both halves of the CLI write for the same message, and therefore the only
  // sound answer to "is our record whole"; see `record.ts`'s `whole`.
  const m = typeof frame.message?.id === 'string' ? frame.message.id : undefined;
  const witness = m ? { m } : undefined;

  const { blocks, files, sizes } = readBlocks(frame.message?.content, cwd);
  // Lifted out of `blocks` before anything below counts them, so a message whose
  // only call was a skill is a chip and no turn at all.
  const chips = skillChips(blocks);
  if (!blocks.length) {
    // A message of nothing but `thinking` still happened, and the wholeness rule
    // counts messages rather than turns. 1 of 3014 messages here is one.
    return witness ? [witness, ...chips] : chips;
  }
  const text = blocks
    .map((b) => ('text' in b ? b.text : ''))
    .filter(Boolean)
    .join('\n\n');

  if (frame.message?.model === SYNTHETIC) {
    // A local command's answer has no tool calls and is not the model speaking,
    // so `chips` is provably empty here and nothing carries it.
    const line: RecordLine | undefined = text ? { ...localReply(text, at), ...witness } : witness;
    return line ? [line] : [];
  }
  // Same lift the disk reader does. An owned card paints this record, not the
  // `.jsonl`, when the record is whole — without this the markdown engine
  // emits the `<img>` the panel CSP (`img-src data:`) refuses. `text` keeps
  // the syntax; the drawn block is the prose with the pictures named beside
  // it. `m` stands in for the jsonl uuid the wire does not carry: the fetch
  // cache is keyed by id, so two messages overwriting one path stay two chips.
  const { blocks: drawn, images } = liftMarkdownImages(blocks, m, cwd);
  const authored: Authored = {
    role: 'assistant',
    text,
    blocks: drawn,
    at,
    ...(files.length ? { files } : {}),
    ...(Object.keys(sizes).length ? { sizes } : {}),
    ...(images.length ? { images } : {})
  };
  // The chip follows the turn that reached for it, which is the order the disk
  // walk leaves them in: `unduplicateSkill` meets the chip first walking
  // backwards, so the caller is the older of the two.
  return [{ ...authored, ...witness }, ...chips];
}

/**
 * The `Skill` calls in a message, lifted out of it as chips.
 *
 * Mutates `blocks`, because a skill is a chip *instead of* a step and not as
 * well as one: `core/claude/transcript.ts`'s `unduplicateSkill` makes the same
 * splice on the disk side, and matching it is the whole point — a skill drawn
 * one way from the `.jsonl` and another way from here is a dock whose thread
 * changes shape with the source it happened to be drawn from.
 *
 * **`by: 'agent'` always.** The disk side can say `'you'` because the CLI
 * expands a typed `/name` into a `<command-name>` entry above the body; the pipe
 * writes no such thing, and `exchangeForSend` above records why a slash command
 * a reader typed is indistinguishable from prose at the moment we write. Who
 * reached for the skill is not what the chip is there to say.
 *
 * A call whose input does not name a skill keeps its row — `Marker.skill` is
 * on every `skill` marker, and a nameless chip says less than the step it
 * replaced.
 */
function skillChips(blocks: Block[]): Marker[] {
  const chips: Marker[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!block || !('call' in block) || block.call.name !== 'Skill') {
      continue;
    }
    // The name the model wrote, where the disk chip is the skill directory's
    // last segment — so a namespaced `caveman:caveman` reads whole here and as
    // `caveman` there. The wire has no directory to read.
    const named = block.call.input?.['skill'];
    if (typeof named !== 'string' || !named) {
      continue;
    }
    blocks.splice(i, 1);
    chips.unshift({ mark: 'skill', skill: named, by: 'agent' });
  }
  return chips;
}

type TaskStart = { wakes: boolean; cause: TaskEnd['cause'] };

/**
 * The tasks a session's CLI has started and not yet ended, by `task_id`.
 *
 * Probed 2026-10-14 (2.1.296, `cli_state/claude/protocol.md` § *Which task
 * ends start a turn*): `task_notification` fires for every task the CLI tracks
 * — a subagent's calls and any long foreground call too — and carries nothing
 * that says whose task it was. Only `task_started` does: a turn follows the end
 * when the start was backgrounded and named no subagent owner, which the
 * subagent's tasks carry and the session's own omit. So the start is kept
 * until its end arrives. Never cleared at a turn's end: an async task's
 * notification comes after the turn that started it has its `result`.
 */
export class ClaudeTasks {
  private readonly started = new Map<string, TaskStart>();

  /** Notes a start, or forgets a task whose end has been read. Call it after
   *  `lineForFrame` has seen the same frame. */
  take(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const frame = value as RawFrame;
    if (frame.type !== 'system' || frame.isReplay === true) return;
    // A subagent's frame, as `lineForFrame` drops it. Its task starts have so
    // far carried `owned_by_subagent` instead, which the rule below reads.
    if (typeof frame.parent_tool_use_id === 'string') return;
    if (typeof frame.task_id !== 'string' || !frame.task_id) return;
    if (frame.subtype === 'task_started') {
      this.started.set(frame.task_id, {
        wakes:
          frame.is_backgrounded === true &&
          frame.owned_by_subagent === undefined &&
          frame.parent_task_id === undefined,
        cause: frame.task_type === 'local_agent' ? 'agent' : 'command'
      });
    } else if (frame.subtype === 'task_notification') {
      this.started.delete(frame.task_id);
    }
  }

  classify(task: string): TaskStart | undefined {
    return this.started.get(task);
  }
}

/**
 * The end of a task whose end starts a turn, off `system/task_notification`.
 *
 * Any other end is nothing here: a subagent's call is not in this conversation,
 * and a foreground call's own `tool_result` follows its notification at once.
 * The frame names the call by `tool_use_id`. The output is not on the pipe,
 * only `summary`, the CLI's sentence about it; the `output_file` path beside it
 * is a file another program wrote, and is not read.
 */
function backgroundEnd(frame: RawFrame, at: number, tasks?: ClaudeTasks): TaskEnd | undefined {
  if (typeof frame.tool_use_id !== 'string' || !frame.tool_use_id) {
    return undefined;
  }
  const start = typeof frame.task_id === 'string' ? tasks?.classify(frame.task_id) : undefined;
  if (!start?.wakes) {
    return undefined;
  }
  const status =
    frame.status === 'completed' || frame.status === 'failed' || frame.status === 'stopped'
      ? frame.status
      : undefined;
  return {
    call: frame.tool_use_id,
    cause: start.cause,
    ...(status ? { status } : {}),
    ...(typeof frame.summary === 'string' ? { output: frame.summary } : {}),
    wakes: true,
    at
  };
}

/**
 * What the calls answered in one `user` frame returned.
 *
 * The pairing is a lookup and never a guess: every result names its call, on the
 * wire (probed 2026-08-20) as on disk (2531 of 2531). `output` is cut by the
 * disk reader's own ceiling — the dock draws one line of it, and this store is
 * read whole on every poll.
 */
function returnedIn(content: unknown): Returned[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const out: Returned[] = [];
  for (const raw of content as RawBlock[]) {
    if (raw?.type !== 'tool_result' || typeof raw.tool_use_id !== 'string' || !raw.tool_use_id) {
      continue;
    }
    const output = outputOf(raw.content);
    const returned: Returned = { id: raw.tool_use_id };
    if (output !== undefined) {
      returned.output = output;
    }
    if (raw.is_error === true) {
      returned.failed = true;
    }
    out.push(returned);
  }
  return out;
}

/**
 * What the drain just put on the wire, as the turns the reader will see.
 *
 * The CLI does not echo a prompt — verified on the pipe, Step 4 — so this is the
 * only place a user turn can come from, and `tryDrain` is the only place a user
 * turn is written.
 *
 * A `command` row files no chip. The `/effort` row ahead of a targeted send
 * sets the flag, and this function cannot see who sent it: the reader, this
 * session, or another session's `--pid`. The CLI answers with a `<synthetic>`
 * frame, and that reply — filed by `exchangeForFrame` — is the record.
 *
 * A slash without the flag is the turn the reader typed. Only the flag
 * decides: a session told `/clear the table` means the table.
 */
export function exchangeForSend(
  sent: Pick<QueuedMessage, 'text' | 'command' | 'images' | 'parts'>,
  at: number,
  refs: readonly (ImageRef | undefined)[] = []
): Exchange[] {
  if (sent.command) return [];
  // One turn per message a merge folded in, each under its own author.
  return sentTurns(sent, refs, at);
}

/**
 * Markdown images out of the drawn blocks, named as refs the chip fetches.
 *
 * Walks the same index the disk reader hands `proseImages`, so two pictures in
 * one run stay two ids. An image-only block is dropped: `ui/fold.ts` keeps the
 * turn alive on `images`, and an empty row above the chip is the thing this
 * would otherwise draw.
 */
function liftMarkdownImages(
  blocks: Block[],
  uuid: unknown,
  cwd: unknown
): { blocks: Block[]; images: NonNullable<Authored['images']> } {
  const out: Block[] = [];
  const images: NonNullable<Authored['images']> = [];
  for (let at = 0; at < blocks.length; at++) {
    const block = blocks[at];
    if (!block || !('text' in block)) {
      if (block) {
        out.push(block);
      }
      continue;
    }
    const { prose, refs } = proseImages(block.text, uuid, at, cwd);
    images.push(...refs);
    if (prose.trim()) {
      out.push({ ...block, text: prose });
    }
  }
  return { blocks: out, images };
}

function readBlocks(
  content: unknown,
  cwd?: string
): { blocks: Block[]; files: string[]; sizes: Record<string, Written> } {
  const blocks: Block[] = [];
  const files: string[] = [];
  const sizes: Record<string, Written> = {};
  if (!Array.isArray(content)) {
    return { blocks, files, sizes };
  }
  for (const raw of content as RawBlock[]) {
    if (raw?.type === 'text' && typeof raw.text === 'string' && raw.text) {
      blocks.push({ text: raw.text });
      continue;
    }
    const narrated = narrationText(raw ?? {});
    if (narrated) {
      blocks.push({ text: narrated, summarized: true });
      continue;
    }
    if (raw?.type === 'tool_use' && typeof raw.name === 'string') {
      const rawInput =
        raw.input !== null && typeof raw.input === 'object' && !Array.isArray(raw.input)
          ? (raw.input as Record<string, unknown>)
          : undefined;
      noteWrite(files, sizes, raw.name, rawInput, cwd);
      const call: ToolCall = {
        id: typeof raw.id === 'string' ? raw.id : '',
        name: raw.name
      };
      // Bounded on the way in — `core/scrub.ts` owns the ceilings and why they
      // are what they are. A `Write` carries a whole file: raw, one turn can put
      // a megabyte in a record nothing ever sweeps.
      const input = scrubbedInput(raw.input);
      if (input) {
        call.input = input;
      }
      blocks.push({ call });
    }
  }
  return { blocks, files, sizes };
}
