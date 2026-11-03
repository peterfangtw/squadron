/**
 * The frames on the CLI's stream-json pipe, narrowed at the point they arrive.
 *
 * Every field here was written by another program, so nothing is cast: a frame
 * is built field by field out of an `unknown`, and a field that is not the type
 * it should be is simply absent. That is why the reducer downstream can read
 * `frame.model` without asking whether the CLI wrote a string there.
 *
 * Names are the repo's, not the wire's — `session_id` arrives and `sessionId`
 * leaves — so exactly one file knows the CLI's spelling. The wire shapes are
 * recorded in `docs/reference/cli_state/claude/protocol.md`, "Driving the CLI over
 * stream-json"; field names below were re-observed against 2.1.220 on
 * 2026-07-27 before this file was written.
 *
 * What is *not* here is anything the transcript already carries. A completed
 * `assistant` or `user` frame is recognised so it counts as a frame of a
 * running turn, and its content is left alone: the thread is read off
 * `~/.claude/projects/…`, which an owned session writes like any other.
 */

import type { TurnOutcome } from '../events';
import { SESSION_ONLY, type PermissionSuggestion, type RateLimits } from '../model';
import { readRateLimitEvent } from './usage';
export type { PermissionSuggestion } from '../model';

/** Anything the CLI sends us, once it has been read. */
export type Frame =
  | SystemFrame
  | StreamFrame
  | MessageFrame
  | ResultFrame
  | RateLimitFrame
  | ResetFrame
  | ControlRequestFrame
  | ControlResponseFrame
  | ControlCancelFrame;

/**
 * `system` — one subtype per thing the CLI wants to say about itself.
 * `init` is the interesting one and arrives **after the first user message**,
 * once per turn rather than once per session.
 *
 * There are around thirty subtypes, most of which say nothing a card reads, and
 * a good half can arrive **outside a turn** — `api_retry`, `notification`,
 * `post_turn_summary`, `worker_shutting_down` and the rest of the starred list
 * in `docs/reference/cli_state/claude/protocol.md`. So the reducer's world is closed:
 * `init` opens a turn, `session_state_changed` states one, `compact_boundary`
 * drops a context reading the compaction behind it invalidated — and everything
 * else is silence.
 */
export type SystemFrame = {
  type: 'system';
  /** `init` · `status` · `thinking_tokens` · `session_state_changed` ·
   *  `hook_started` · `hook_response` … (the full list is in the reference) */
  subtype: string;
  sessionId?: string;
  /** `init` only. */
  cwd?: string;
  model?: string;
  permissionMode?: string;
  /** `session_state_changed` only: `running` · `idle` · `requires_action`. The
   *  CLI's own word for what the session is doing, emitted only when the child
   *  was started with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`. */
  state?: string;
};

/**
 * `stream_event` — the Anthropic streaming events, passed through. Only the
 * three a card reads are pulled out.
 *
 * `parentToolUseId` is what separates the session's own message from a
 * subagent's. A `Task` running underneath streams its own `message_start`
 * frames, and counting one of those as the session's context would report the
 * subagent's window on the parent's card.
 */
export type StreamFrame = {
  type: 'stream_event';
  /** `message_start` · `content_block_start` · `content_block_delta` … */
  event: string;
  /** Set when this belongs to a subagent rather than to the session. */
  parentToolUseId?: string;
  /** `content_block_delta` of a `text_delta`. */
  text?: string;
  /** `content_block_start` of a `tool_use`. */
  toolName?: string;
  /** `message_start`. */
  model?: string;
  /**
   * `message_start`: the id every root `assistant` frame of this message
   * carries, so text streamed under it is keyed by the frame that will
   * complete it (2.1.289, protocol.md, "`message_start` names the message").
   */
  messageId?: string;
  /** `content_block_start` · `content_block_delta` · `content_block_stop`:
   *  which block of the message. */
  index?: number;
  /**
   * `message_start`: what this message was sent with — input plus both cache
   * counts, which is the numerator the CLI's own context bar divides. Not a
   * running total: each message states the whole context it ran against, so the
   * newest wins rather than accumulating (`core/claude/context.ts`).
   */
  contextTokens?: number;
  /** `message_start`: input tokens read from the prompt cache. Absent when the
   *  count was not stated, which is unknown rather than zero. */
  cacheRead?: number;
};

/** A completed message — one frame per content block, so a turn that says
 *  something and then calls a tool emits two. Recognised so a turn's frames are
 *  all accounted for; its content is the transcript's job. A message completing
 *  is not the moment it lands on disk, though: a `user` frame is a tool result,
 *  and *that* is what says the CLI has appended the turn the tool belonged to.
 *  `parentToolUseId` for the same reason it is on a stream frame: a subagent
 *  finishing a message says nothing about ours. */
/**
 * `isReplay` is the CLI's own marker for a frame that is an **echo rather than
 * a turn**: it restates something that already happened instead of reporting
 * work. A `set_model` answers with one — a `user` frame carrying
 * `<local-command-stdout>Set model to haiku (…)</local-command-stdout>` — and it
 * arrives with the session idle and nothing following it.
 *
 * Without this field every such echo read as a turn beginning, and since no
 * `result` comes after one, the card went busy and stayed busy until some later
 * turn ended. Observed on the `user` frame (2026-08-06, 2.1.220); read on both
 * kinds because the flag says the same thing wherever the CLI puts it.
 */
export type MessageFrame = {
  type: 'assistant' | 'user';
  parentToolUseId?: string;
  isReplay?: boolean;
  /** `assistant`: the message this block belongs to — `message_start`'s id. */
  messageId?: string;
  /**
   * `assistant`: the block was cut by an interrupt, and the frame carries the
   * text received so far (2.1.292, protocol.md, "Mid-text interrupt"). A
   * completing frame is therefore no proof that the prose finished.
   */
  aborted?: true;
};

/**
 * `result` — the end of a turn, whatever ended it. `subtype` is `success` even
 * for a turn that could not run and `error_during_execution` for an interrupted
 * one, so how it ended is read off `terminal_reason` alone.
 */
export type ResultFrame = {
  type: 'result';
  /** Off `terminal_reason`; absent for a word not read below or none at all. */
  outcome?: TurnOutcome;
  /**
   * The CLI answered the prompt itself and never called the model: a local,
   * gated or unknown slash command, `/clear`, `/model x`, `/usage` and
   * `/compact` among them, typed or ours. `num_turns: 0` is its marker on every
   * one (`cli_state/claude/commands.md`, the three classes). A turn that could
   * not run reaches no model either, and says `api_error`: still a turn.
   */
  local?: true;
  /** `modelUsage`, keyed by model id — the only statement of a model's context
   *  window that reaches an owned session, since it writes no statusline dump. */
  contextWindows?: Record<string, number>;
};

/** `rate_limit_event` — the five-hour reset time, and from 2.1.309 both
 *  windows' quota. A process emits it with an API response; turns that leave
 *  the figures unchanged emit none, so `get_usage` remains the reader. */
export type RateLimitFrame = {
  type: 'rate_limit_event';
  /** Epoch **seconds**, as the CLI writes it here. `five_hour` is the only
   *  window this field speaks about. */
  resetsAt?: number;
  /** Undated: the session stamps it on arrival. */
  usage?: RateLimits;
};

/**
 * `conversation_reset` — a `/clear`. The process lives on; the conversation it
 * was having does not.
 *
 * A **top-level** frame type rather than a `system` subtype, which is where
 * every other CLI self-statement lives — measured on the pipe 2026-08-19, so
 * `readFrame`'s `default` really was dropping it. Nothing else is read off it:
 * it carries a `new_conversation_id`, and that field is **not** the id the
 * conversation continues under. The reset announced `0b3b4588…` and the `init`
 * immediately after it reported `d2da5a3a…`, which is what every later frame and
 * the new transcript file carry. So the new conversation is named by the next
 * `init`, exactly as it always was, and this frame's only job is to say that the
 * old one has ended.
 */
export type ResetFrame = { type: 'conversation_reset' };

/**
 * `control_request` — the CLI asking us something. `can_use_tool` is the one
 * that matters: both a question for the reader and a permission prompt arrive
 * as one, told apart by `requiresUserInteraction`.
 */
export type ControlRequestFrame = {
  type: 'control_request';
  requestId: string;
  /** `can_use_tool` · `request_user_dialog` … */
  subtype: string;
  toolName?: string;
  /** The call this request is about, in the CLI's own `tool_use.id`. The one
   *  thing joining a request on this pipe to the `tool_use` block an `assistant`
   *  frame already carried — which is how an answered ask reaches the call it
   *  answers in our record (`core/record.ts`). */
  toolUseId?: string;
  input?: Record<string, unknown>;
  /** The CLI's own short label for the call: `notes.txt`, `Write hi to out.txt`. */
  description?: string;
  /** Set on an `AskUserQuestion`, absent on a permission prompt. */
  requiresUserInteraction?: boolean;
  suggestions?: PermissionSuggestion[];
};

/** `control_response` — the answer to a request **we** sent. */
export type ControlResponseFrame = {
  type: 'control_response';
  requestId: string;
  ok: boolean;
  error?: string;
  /** The `response.response` body: `{still_queued}` for an interrupt, the whole
   *  usage record for `get_usage`. */
  payload?: Record<string, unknown>;
};

/**
 * `control_cancel_request` — a request of the CLI's is retracted, and the
 * prompt on screen for it must go. Observed arriving ~1ms after an interrupt
 * and *before* the interrupt's own response.
 */
export type ControlCancelFrame = { type: 'control_cancel_request'; requestId: string };

/** Where it lives now: an image on a message is the panel's shape, not this
 *  CLI's, and `core/coordination/requests.ts` carries one cross-window. Re-exported so the
 *  frame builders below still read as one file's vocabulary. */
import type { ImageBlock } from '../model';
export type { ImageBlock };

/** A line we write. Serialised by the transport, which owns the newline. */
export type Outbound = { type: string } & Record<string, unknown>;

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * One frame out of one parsed line, or undefined for anything this does not
 * recognise — a frame type added by a later CLI reads as silence rather than
 * as an error, which is the same way every other reader here treats the
 * unfamiliar.
 */
export function readFrame(value: unknown): Frame | undefined {
  const frame = rec(value);
  const type = str(frame?.type);
  if (!frame || !type) {
    return undefined;
  }
  switch (type) {
    case 'system':
      return readSystem(frame);
    case 'stream_event':
      return readStream(frame);
    case 'assistant':
    case 'user': {
      const out: MessageFrame = { type, parentToolUseId: str(frame.parent_tool_use_id) };
      if (frame.isReplay === true) {
        out.isReplay = true;
      }
      const messageId = str(rec(frame.message)?.id);
      if (type === 'assistant' && messageId) {
        out.messageId = messageId;
      }
      if (type === 'assistant' && frame.aborted === true) {
        out.aborted = true;
      }
      return out;
    }
    case 'result':
      return readResult(frame);
    case 'rate_limit_event':
      return {
        type: 'rate_limit_event',
        resetsAt: num(rec(frame.rate_limit_info)?.resetsAt),
        usage: readRateLimitEvent(frame.rate_limit_info)
      };
    case 'conversation_reset':
      return { type: 'conversation_reset' };
    case 'control_request':
      return readControlRequest(frame);
    case 'control_response':
      return readControlResponse(frame);
    case 'control_cancel_request': {
      const requestId = str(frame.request_id);
      return requestId ? { type: 'control_cancel_request', requestId } : undefined;
    }
    default:
      return undefined;
  }
}

function readSystem(frame: Record<string, unknown>): SystemFrame | undefined {
  const subtype = str(frame.subtype);
  if (!subtype) {
    return undefined;
  }
  return {
    type: 'system',
    subtype,
    sessionId: str(frame.session_id),
    cwd: str(frame.cwd),
    model: str(frame.model),
    permissionMode: str(frame.permissionMode),
    state: str(frame.state)
  };
}

function readStream(frame: Record<string, unknown>): StreamFrame | undefined {
  const event = rec(frame.event);
  const name = str(event?.type);
  if (!event || !name) {
    return undefined;
  }
  const out: StreamFrame = {
    type: 'stream_event',
    event: name,
    parentToolUseId: str(frame.parent_tool_use_id)
  };
  const index = num(event.index);
  if (index !== undefined) {
    out.index = index;
  }
  if (name === 'content_block_delta') {
    const delta = rec(event.delta);
    if (str(delta?.type) === 'text_delta') {
      out.text = str(delta?.text);
    }
  } else if (name === 'content_block_start') {
    const block = rec(event.content_block);
    if (str(block?.type) === 'tool_use') {
      out.toolName = str(block?.name);
    }
  } else if (name === 'message_start') {
    const message = rec(event.message);
    out.model = str(message?.model);
    const id = str(message?.id);
    if (id) {
      out.messageId = id;
    }
    const usage = rec(message?.usage);
    if (usage) {
      // The three the CLI's own bar adds up, and not the output tokens, which
      // it counts against the window separately (`transcript.readStats` sums
      // the same three off the transcript, verified against a dump).
      const tokens =
        (num(usage.input_tokens) ?? 0) +
        (num(usage.cache_creation_input_tokens) ?? 0) +
        (num(usage.cache_read_input_tokens) ?? 0);
      out.contextTokens = tokens || undefined;
      const read = num(usage.cache_read_input_tokens);
      if (read !== undefined && Number.isFinite(read) && read >= 0) out.cacheRead = read;
    }
  }
  return out;
}

function readResult(frame: Record<string, unknown>): ResultFrame {
  const out: ResultFrame = { type: 'result' };
  const outcome = outcomeOf(str(frame.terminal_reason));
  if (outcome) {
    out.outcome = outcome;
  }
  if (num(frame.num_turns) === 0 && outcome !== 'error' && outcome !== 'interrupted') {
    out.local = true;
  }
  const windows: Record<string, number> = {};
  for (const [model, usage] of Object.entries(rec(frame.modelUsage) ?? {})) {
    const size = num(rec(usage)?.contextWindow);
    if (size !== undefined && size > 0) {
      windows[model] = size;
    }
  }
  if (Object.keys(windows).length) {
    out.contextWindows = windows;
  }
  return out;
}

/**
 * `api_error` is every turn that could not run — 529, 403, 400, and signed out
 * with no request made. `subtype` says `success` on all of them
 * (2.1.289, protocol.md, "`terminal_reason` on a finished turn…").
 */
function outcomeOf(reason: string | undefined): TurnOutcome | undefined {
  switch (reason) {
    case 'completed':
      return 'done';
    case 'aborted_streaming':
    case 'aborted_tools':
      return 'interrupted';
    case 'api_error':
      return 'error';
    default:
      return undefined;
  }
}

function readControlRequest(frame: Record<string, unknown>): ControlRequestFrame | undefined {
  const requestId = str(frame.request_id);
  const request = rec(frame.request);
  const subtype = str(request?.subtype);
  if (!requestId || !request || !subtype) {
    return undefined;
  }
  const out: ControlRequestFrame = {
    type: 'control_request',
    requestId,
    subtype,
    toolName: str(request.tool_name),
    toolUseId: str(request.tool_use_id),
    input: rec(request.input),
    description: str(request.description)
  };
  if (request.requires_user_interaction === true) {
    out.requiresUserInteraction = true;
  }
  const suggestions = Array.isArray(request.permission_suggestions)
    ? request.permission_suggestions
    : [];
  const read: PermissionSuggestion[] = [];
  for (const entry of suggestions) {
    const raw = rec(entry);
    const kind = str(raw?.type);
    if (raw && kind) {
      const where = WHERE[str(raw.destination) ?? ''];
      read.push({ kind, ...(where ? { where } : {}), raw });
    }
  }
  if (read.length) {
    out.suggestions = read;
  }
  return out;
}

/**
 * Where an always-allow writes, in the words of what it actually does rather
 * than in the CLI's field names. `cliArg` is deliberately absent: it names a
 * flag this process passed at spawn, which no button here can go back and
 * change, so a request suggesting one is offered no always-allow at all.
 */
const WHERE: Record<string, string> = {
  session: SESSION_ONLY,
  localSettings: '.claude/settings.local.json, in this project',
  projectSettings: 'the project’s shared .claude/settings.json',
  userSettings: '~/.claude/settings.json, every session on this machine'
};

function readControlResponse(frame: Record<string, unknown>): ControlResponseFrame | undefined {
  const response = rec(frame.response);
  const requestId = str(response?.request_id);
  if (!response || !requestId) {
    return undefined;
  }
  return {
    type: 'control_response',
    requestId,
    ok: str(response.subtype) === 'success',
    error: str(response.error),
    payload: rec(response.response)
  };
}

/**
 * A turn, as the CLI takes it: one text block per segment, each segment's images
 * straight after its words (`segments` in `core/live.ts`). Images ride inline as
 * content blocks — an owned session needs no file on disk and no path in the
 * prose, which is the whole of why `pastes.ts` is not on this path.
 *
 * The CLI keeps the blocks as written, in its transcript and in order (probed
 * 2026-10-04, 2.1.288), which is what lets its file name each merged message's
 * author.
 *
 * No `session_id` and no `parent_tool_use_id`: the CLI accepted the message
 * without either (observed 2026-07-27), and a field we do not have to state is
 * a field that cannot go stale against the session the CLI thinks it is in.
 */
export function userMessage(
  segments: readonly { text: string; images: readonly ImageBlock[] }[]
): Outbound {
  const content: Record<string, unknown>[] = [];
  for (const { text, images } of segments) {
    if (text) {
      content.push({ type: 'text', text });
    }
    for (const image of images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data }
      });
    }
  }
  return { type: 'user', message: { role: 'user', content } };
}

/** A request of ours: `interrupt`, `get_usage`, `set_permission_mode`, … */
export function controlRequest(
  requestId: string,
  subtype: string,
  fields: Record<string, unknown> = {}
): Outbound {
  return { type: 'control_request', request_id: requestId, request: { subtype, ...fields } };
}

/** Our answer to one of the CLI's requests. */
export function controlResponse(requestId: string, response: Record<string, unknown>): Outbound {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response }
  };
}

/** Our refusal to answer one — a request subtype this client does not speak.
 *  Better than silence, which leaves the CLI waiting on a reply that is never
 *  coming. The error envelope itself is from the bundle's schema and has not
 *  been observed on the wire. */
export function controlError(requestId: string, error: string): Outbound {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } };
}
