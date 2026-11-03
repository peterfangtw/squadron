import type { Conversation } from '../thread';
import type { RecordLine } from '../record';
import type { Frame, MessageFrame, StreamFrame } from './frames';
import { ClaudeTasks, lineForFrame } from './tee';

export class ClaudeProjection {
  /**
   * The root message streaming now and the block of it open, from its
   * `message_start` and `content_block_start`. A block's `assistant` frame
   * lands before the next block starts (2.1.289, protocol.md), so the frame
   * closes the row this names and then consumes it.
   */
  private block: { message?: string; index?: number } = {};
  private readonly tasks = new ClaudeTasks();
  private unstreamed = 0;

  take(
    conversation: Conversation,
    value: unknown,
    frame: Frame | undefined,
    cwd: string,
    running: boolean
  ): void {
    if (frame?.type === 'stream_event') {
      if (!frame.parentToolUseId) this.stream(conversation, frame);
      return;
    }
    const lines = lineForFrame(value, Date.now(), cwd, this.tasks);
    this.tasks.take(value);
    if (frame?.type === 'assistant' && !frame.parentToolUseId && !frame.isReplay) {
      this.closeBlock(conversation, frame, lines);
      return;
    }
    // A turn's end: a block still streaming has stopped without its frame.
    // The `idle` state frame ends a turn whose `result` never came (`reduce`).
    const idled =
      frame?.type === 'system' &&
      frame.subtype === 'session_state_changed' &&
      frame.state === 'idle' &&
      running;
    if (frame?.type === 'result' || idled) conversation.cutOpen();
    if (lines.length) conversation.note(lines);
  }

  private stream(conversation: Conversation, frame: StreamFrame): void {
    if (frame.event === 'message_start') {
      this.block = { message: frame.messageId };
    } else if (frame.event === 'content_block_start') {
      this.block = { ...this.block, index: frame.index };
    } else if (frame.text) {
      const index = frame.index ?? this.block.index;
      conversation.stream(`${this.block.message ?? ''}:${index ?? ''}`, frame.text, Date.now());
    }
  }

  /** One block's completing frame, onto the row its deltas streamed under. */
  private closeBlock(
    conversation: Conversation,
    frame: MessageFrame,
    lines: readonly RecordLine[]
  ): void {
    const { message, index } = this.block;
    let row: string;
    if (frame.messageId !== undefined && frame.messageId === message && index !== undefined) {
      row = `${message}:${index}`;
      this.block = { message };
    } else {
      row = `${frame.messageId ?? ''}~${this.unstreamed++}`;
    }
    if (!frame.aborted) {
      if (lines.length) conversation.complete(row, lines);
      return;
    }
    const authored = lines.find((line) => 'role' in line);
    conversation.cut(row, authored && 'role' in authored ? authored : undefined);
    const rest = lines.filter((line) => line !== authored);
    if (rest.length) conversation.note(rest);
  }
}
