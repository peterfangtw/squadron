/**
 * A background command's end, in our words, and the record lines it becomes.
 *
 * A CLI can end a turn while a shell command it started keeps running. When
 * the command exits, each brand says so on the pipe in its own spelling; each
 * brand's tee narrows that into a `TaskEnd` and this is the one place it turns
 * into lines. No brand's spelling belongs here (`reference/brand_seam.md`).
 */

import type { RecordLine } from './record';
import { cutOutput, type Marker } from './transcript';

export type TaskEnd = {
  /** The id of the call that started it, as its call line holds it. Absent
   *  when that call lives in another conversation — a subagent's command
   *  handed to this one — so there is no row here to fold the end onto. */
  call?: string;
  /** What ended: a shell command, or an agent run in the background. */
  cause: 'command' | 'agent';
  /** How it ended, in the CLI's word mapped once by its tee. Absent when the
   *  CLI said nothing readable. */
  status?: NonNullable<Marker['status']>;
  /** What the CLI handed over as the result: the command's output, or its
   *  own sentence about it where it hands no output. Uncut. */
  output?: string;
  /** Whether the CLI starts a turn for it. Only then is there a turn whose
   *  cause the reader needs telling. Each brand decides it from its own wire,
   *  and says false when its wire cannot tell. */
  wakes: boolean;
  /** When the end reached us, epoch ms. */
  at: number;
};

/**
 * The end on its call as a `{ret}`, then a trigger marker when a turn follows.
 * With no call there is no `{ret}`, and an end that also starts no turn is
 * nothing at all.
 *
 * **`output` is always set.** `readRecord` keeps a call's previous output when
 * a `{ret}` carries none, so an end with nothing to say would leave "running in
 * background" on the row forever; `''` says it finished with nothing printed.
 *
 * **`failed` is never set.** That flag means the result carried an error; a dev
 * server killed with 143 is the task manager ending it, and a red row would
 * report the ordinary case as a fault. The marker carries the status instead.
 */
export function taskEndLines(end: TaskEnd): RecordLine[] {
  const lines: RecordLine[] = end.call
    ? [{ ret: [{ id: end.call, output: cutOutput(end.output ?? '') ?? '' }] }]
    : [];
  if (end.wakes) {
    lines.push({
      mark: 'trigger',
      trigger: end.cause === 'agent' ? 'agent' : 'task',
      ...(end.status ? { status: end.status } : {}),
      at: end.at
    });
  }
  return lines;
}
