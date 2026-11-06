/** Seed and brief the first workflow turn; stage mentions until their send succeeds. */

import * as platform from '../platform';
import type * as commands from '../platform/commands';
import { mkdir, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import { stepCommand } from '../paths';
import {
  NOTE_MAX,
  progressPath,
  seedProgress,
  writeProgress,
  type ProgressSeed
} from './progress_store';
import { enrich, type ReadWorkflow } from './workflows';

/**
 * Host-append copy after a successful seed — visible in the thread like enrich.
 *
 * The pull instruction, and the whole of what a session is told about how to run
 * a workflow. It replaced four sentences asking the agent to set each step's
 * status by hand: `squadron-step` moves the cursor now, and the definition is
 * never named or handed over (`PRD_shipped_step_blind_workflows.md` §3A).
 *
 * It still names the progress path, which is the run's durable anchor — the one
 * string that survives compaction and a window reload. The agent is not being
 * told to edit it, only where its run is written down.
 *
 * **It says why, not only what.** §4 is explicit that an agent with filesystem
 * access can read the definition anyway, so the cheapest thing that makes not
 * looking a cooperative act rather than a puzzle is a sentence saying what is
 * happening: an agent that notices the gap and has no stated reason for it is
 * the one that goes looking.
 *
 * The shim is quoted absolute, as every verb an agent is handed is. The
 * directory line is not politeness: a step's prompt can name `${cwd}` and the
 * CLI fills that from wherever it was invoked, so a call from a subdirectory
 * quietly points the step at a subtree.
 */
export function progressBriefing(file: string, shell: commands.Shell): string {
  const note = platform.commands.placeholder('<what you did>', shell);
  return [
    `Progress for this workflow run is tracked at ${file}.`,
    `This workflow is served one step at a time: run \`${stepCommand(shell, 'next')}\` for your next instruction, and \`${stepCommand(shell, 'done', '--note')} ${note}\` once that step is finished.`,
    `Keep that note under ${NOTE_MAX} characters — a line or three saying what you did, not an account of the work. A longer one is refused and the step stays unfinished.`,
    'Call it from the directory this session started in.',
    'You are not given the later steps on purpose, so that the work at each one is shaped by that step rather than by criteria further down the chain.',
    'Do not read the workflow file.'
  ].join(' ');
}

/**
 * Put the briefing under the enriched body so both are visible in the thread.
 * Pure — the host decides whether to call this after a successful seed write.
 */
export function withProgressBriefing(body: string, file: string, shell: commands.Shell): string {
  return `${body}\n\n${progressBriefing(file, shell)}`;
}

/**
 * A seeded progress file held one rename away from being the session's.
 *
 * The briefing has to name the path in the **same message** that gives the
 * agent the work, so the content must exist before the send — but every path
 * after that can still refuse, and one file per session means writing it
 * straight to `progressPath` would overwrite a workflow already running there
 * and have nothing to put back.
 *
 * So it is staged beside the real name and committed on the one line where the
 * message is taken. A refusal deletes a temp and never touches the live file:
 * there is no snapshot to go stale, no read-modify-write for two sends to race
 * on (they stage separately and the winner is whoever renames last, which is
 * the last-write-wins this always had), and a crash between staging and either
 * outcome leaves a file `prune.ts` already sweeps. The agent cannot read the
 * staged path early because it has not been given the turn yet.
 *
 * `undefined` when the staging write fails: the send proceeds on enrich alone.
 */
export type StagedProgress = {
  /** Where it will land — what the briefing names. */
  file: string;
  commit: () => Promise<void>;
  discard: () => Promise<void>;
};

export async function stageForSend(seed: ProgressSeed): Promise<StagedProgress | undefined> {
  const file = progressPath(seed.sessionId);
  // Not `.tmp`: `writeAtomicJson` owns that suffix for its own rename, and two
  // writers sharing a name is how a half-written file becomes a read one.
  const staged = `${file}.${process.pid}.staging`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(staged, JSON.stringify(seedProgress(seed)));
  } catch {
    await rm(staged, { force: true }).catch(() => {});
    return undefined;
  }
  return {
    file,
    commit: async () => {
      await platform.files.replace(staged, file).catch(() => {});
    },
    discard: async () => {
      await rm(staged, { force: true }).catch(() => {});
    }
  };
}

/**
 * The first turn a spawn is given: its prompt, or its prompt inside a workflow.
 *
 * The same three things a mention does (`host/session_io.ts`) — name the file
 * rather than inline the steps, seed the run before the message that briefs it,
 * name the path in that same message — with one deliberate difference: this
 * writes straight to the run where a mention stages. The id was minted seconds
 * ago and nothing else has ever been keyed to it, so there is nothing to
 * overwrite and nothing to put back.
 *
 * A failed write is non-fatal: the enriched line still goes out, and a session
 * running the steps untracked beats one that never got the workflow at all.
 * An empty `sessionId` is that same case rather than a key: a brand that states
 * its id late would otherwise be briefed to drive `runs/.progress.json`, which
 * is the bug this argument exists to avoid, written by the guard against it.
 */
export async function workflowFirstTurn(
  prompt: string,
  workflow: ReadWorkflow | undefined,
  sessionId: string,
  shell: commands.Shell,
  signal?: AbortSignal
): Promise<string> {
  if (!workflow) {
    return prompt;
  }
  signal?.throwIfAborted();
  const body = enrich(workflow, prompt);
  const seeded =
    sessionId !== '' &&
    (await writeProgress(
      seedProgress({
        sessionId,
        workflowId: workflow.id,
        label: workflow.label,
        steps: workflow.steps
      })
    ));
  if (signal?.aborted) {
    if (seeded) await rm(progressPath(sessionId), { force: true });
    signal.throwIfAborted();
  }
  return seeded ? withProgressBriefing(body, progressPath(sessionId), shell) : body;
}
