import type { RecordLine } from '../../core/record';

import type { Exchange, ToolCall } from '../../core/transcript';

import { isMarker } from '../../core/transcript';

import { tempHome } from '../helpers';

export type Record = typeof import('../../core/record');

export type GrokTee = InstanceType<typeof import('../../core/grok/tee').GrokTee>;

export let record: Record;

export let Tee: typeof import('../../core/grok/tee').GrokTee;

export let linesOf: typeof import('../../core/grok/tee').linesOf;

/** One `session/update`, as the wire wraps it. */
export function update(sessionUpdate: string, rest: object = {}, meta?: object): unknown {
  return { sessionId: 'g1', update: { sessionUpdate, ...rest }, ...(meta ? { _meta: meta } : {}) };
}

/** A fixed clock: `at` is what the tee stamps, and a real one would make every
 *  `deepEqual` below unwritable. */
export const AT = 1_700_000_000_000;

export const take = (tee: GrokTee, params: unknown): RecordLine[] =>
  linesOf(tee.teed('session/update', params, AT));

export const endLines = (tee: GrokTee): RecordLine[] =>
  linesOf(tee.closeTurn({ stop: 'end_turn' }, AT));

/** The nth block of a flushed assistant line, as a call. A chunk's own prose is
 *  block 0 when it said anything, so a call that followed it is block 1. */
export function callAt(line: Exchange | undefined, at: number): ToolCall | undefined {
  const block = line && !isMarker(line) ? line.blocks?.[at] : undefined;
  return block && 'call' in block ? block.call : undefined;
}

export const setup = async (): Promise<void> => {
  // **Every one of these after the home moves, and none of them at the top.**
  // `core/paths.ts` resolves its directories once at load, and both the tee and
  // the disk reader reach it through `core/pastes.ts` — so a top-level import
  // of either makes this file append its fixtures into the real
  // `~/.squadron/transcripts/`. It has done, twice.
  await tempHome();
  record = await import('../../core/record');
  ({ GrokTee: Tee, linesOf } = await import('../../core/grok/tee'));
};
