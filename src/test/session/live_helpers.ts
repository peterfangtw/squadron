import * as assert from 'node:assert/strict';

import { tempHome } from '../helpers';

export type Live = typeof import('../../core/live');

export type Reduce = typeof import('../../core/claude/reduce');

export type Frames = typeof import('../../core/claude/frames');

export let live: Live;

export let reduce: Reduce;

export let frames: Frames;

/** One frame, as it arrives: written in the CLI's spelling and read through
 *  `readFrame`, so a test can never agree with the reducer about a field name
 *  the CLI does not use. */
export function frame(wire: unknown): NonNullable<ReturnType<Frames['readFrame']>> {
  const read = frames.readFrame(wire);
  assert.ok(read, 'the fixture should be a frame this reader recognises');
  return read;
}

/** Every frame in order, from the state a spawn starts with. */
export function run(
  wires: unknown[],
  from?: ReturnType<Live['initial']>
): ReturnType<Live['initial']> {
  return wires.reduce<ReturnType<Live['initial']>>(
    (state, wire) => reduce.reduce(state, frame(wire)),
    from ?? live.initial({ cwd: '/repo/app', startedAt: 1000 })
  );
}

export const INIT = {
  type: 'system',
  subtype: 'init',
  cwd: '/repo/app',
  session_id: 'sess-1',
  model: 'claude-opus-5',
  permissionMode: 'acceptEdits'
};

export const delta = (
  text: string
): {
  type: string;
  event: { type: string; delta: { type: string; text: string } };
  parent_tool_use_id: null;
} => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  parent_tool_use_id: null
});

/** The one frame that states a session's context: input plus both cache counts,
 *  which is the numerator the CLI's own bar divides. 28_317 against Opus 5's
 *  window is 3%. */
export const messageStart = {
  type: 'stream_event',
  event: {
    type: 'message_start',
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 11_583,
        cache_read_input_tokens: 16_732
      }
    }
  },
  parent_tool_use_id: null
};

export const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  modelUsage: { 'claude-opus-5': { contextWindow: 1_000_000 } }
};

export const askRequest = {
  type: 'control_request',
  request_id: 'req-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'toolu_1',
    requires_user_interaction: true,
    input: {
      questions: [
        { question: 'Which fruit?', multiSelect: false, options: [{ label: 'Banana' }] },
        {
          question: 'Which colours?',
          multiSelect: true,
          options: [{ label: 'Red' }, { label: 'Blue' }]
        }
      ]
    }
  }
};

export const writeRequest = {
  type: 'control_request',
  request_id: 'req-2',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Write',
    description: 'notes.txt',
    input: { file_path: '/tmp/notes.txt', content: 'hi' },
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
  }
};

export const setup = async (): Promise<void> => {
  await tempHome();
  live = await import('../../core/live');
  reduce = await import('../../core/claude/reduce');
  frames = await import('../../core/claude/frames');
};
