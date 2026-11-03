/**
 * Squadron: ask for the next step of the workflow you are running.
 *
 * The delivery half of step-blind workflows. A mentioned workflow used to reach
 * a session as a path, so the agent's first act was to read the whole file and
 * every later step's criteria were in context before step 1 began — an agent
 * that can see step 5 while doing step 2 optimises toward step 5
 * (`docs/PRD/PRD_shipped_step_blind_workflows.md` §1). This serves one step, and
 * the agent pulls.
 *
 * **A call that opens nothing asks no window, and that is what keeps it inside
 * §15.** A panel-driven sequencer was built, argued about and deleted once
 * (`PRD_shipped_workflows.md` §15, `TASK_done_kill_run.md`); its three reasons
 * were all about the panel being in the critical path. Serving a step, marking
 * one done, and registering a wait are all on disk — the definitions under
 * `workflows/`, the cursor under `runs/`, the wait under `waits/` — so there
 * is no request, no reply, no poll, and no click. Work continues with every
 * panel closed, which is the first of those reasons. A live window is still
 * needed: its claim carries Orchestration's switch (`gate.ts`).
 *
 * **`next` in a run whose file names a lane is the exception.** Opening a lane
 * is the same ask `squadron-spawn` makes (`openSession`), and ending one whose
 * picked model never started is the same close `squadron-end` makes, so the
 * anchor's `next` can exit 2, 3, 4 or 5 on that path. Any `next` in such a
 * run — a lane's included — can register a wait, which needs the board, so it
 * can exit 3 too. A lane's own `next` never opens a lane, and neither does any
 * call that only serves or finishes a step.
 *
 * **There is no failure verb.** `done` is a pure completion. `check` has never
 * run and most steps have no deterministic check to add, so a `--failed` flag
 * would only launder an agent's self-report into a status the file states as
 * fact. A step that cannot be finished stalls: the agent stops calling this,
 * the step stays `in_progress`, and the run stops advancing. That is priced in
 * rather than overlooked — §3A.1 records what it costs, including that a stall
 * is not visually distinct from work in flight.
 *
 * Bundled by `esbuild.mjs` into `dist/squadron-step.js`, which the extension
 * copies to `~/.squadron/bin/squadron-step` — one self-contained file, for
 * the reason `spawn.ts` says.
 *
 * Exit codes, `list`'s table. 3 is no live window, which leaves
 * Orchestration's switch unread (`gate.ts`). 4 exists while the anchor is
 * opening a lane, or ending one whose window went silent. Ending that child —
 * a session this command opened — can also exit 2 (the window refused) or 5
 * (the close could not be asked). A member with no window id is that 5, not a
 * 3. Every other call still cannot reach 4 or 5:
 *   0  a step was served or reprinted, a lane was opened, a wait was
 *      registered, or the run is complete. Which one is said on **stdout's
 *      first line**, not by the code: a looping agent needs to tell "here is
 *      your step" from "there are no more" without a second call, and both
 *      are successes
 *   1  bad usage — the arguments, and only the arguments
 *   2  refused: Orchestration is off, no caller could be identified, no run
 *      at this session, the run was cancelled or is blocked, a lane is
 *      stalled, the run a lane was opened for is over, the definition is gone,
 *      `done` was called with nothing in progress, or the wait about to be
 *      registered would be the third in a row over idle sessions with nothing
 *      in the run moving (`holdAfter`) — it stays refused until something moves
 *   3  no live IDE window — so the switch cannot be read, or the anchor is
 *      about to open a lane or register a wait and nothing is up to do it
 *   4  a window was asked to open a lane, or to end one, and never answered.
 *      `openSession`'s `unanswered`: a session may still have started
 *   5  the record is there and could not be read, or a record, a wait or a
 *      close could not be written. Distinct from 2 because the arguments were
 *      fine and the machine is not: a model told "refused" reasons about the
 *      run, and retries a correct command against a broken disk (`spawn.ts`,
 *      2026-08-18)
 */

import * as gate from './gate';
import * as help from './help';
import * as fs from 'fs/promises';
import * as path from 'path';
import { askExit } from '../core/coordination/ask';
import { readLineage, type LineageEntry } from '../core/coordination/lineage';
import { writeWait, type WaitRecord } from '../core/coordination/wait';
import type { Session } from '../core/model';
import { stepCommand, toolShell } from '../core/paths';
import type * as commands from '../core/platform/commands';
import { decideNext, pickName, type NextDecision } from '../core/workflows/next';
import {
  CompleteResult,
  LaneOpen,
  Progress,
  SpawnEdge,
  armingMiss,
  completeCurrent,
  progressPath,
  readProgress,
  readRunRecords,
  runMoved,
  seedProgress,
  writeProgress
} from '../core/workflows/progress';
import * as authoring from '../core/workflows/authoring';
import * as graph from '../core/workflows/graph';
import {
  ARMED_LANE_EMPTY,
  Workflow,
  noSuchWorkflow,
  readWorkflows
} from '../core/workflows/workflows';
import { Flags, ownBrand, ownSessionId, parseFlags, Renamed, usageFor } from './args';
import { loadBoard } from './board';
import type { TargetContext } from '../core/session_target';
import {
  openSession,
  resolveOrigin,
  type OpenSessionRequest,
  type OpenSessionResult
} from './open';
import { closeOne, endPlan } from './end_plan';
import { registered, waitPlan } from './wait_plan';
import * as inputFile from './input_file';

const USAGE = [
  'usage: squadron-step start --workflow-id <id> [--lane <name> --anchor-session-id <sessionId> --opened <n>] [--force] [--caller-session-id <sessionId>]',
  '       squadron-step next [--caller-session-id <sessionId>]',
  '       squadron-step done [--note <text>] [--caller-session-id <sessionId>]'
].join('\n');

export const FLAGS = [
  'caller-session-id',
  'note',
  'workflow-id',
  'force',
  'lane',
  'anchor-session-id',
  'opened'
] as const;
const BARE = ['force'] as const;

/** `--workflow-id`, as `squadron-spawn` takes it: the workflow's `id`, never its filename. */
const RENAMED: Renamed<typeof FLAGS> = {
  workflow: 'workflow-id',
  caller: 'caller-session-id',
  anchor: 'anchor-session-id'
};

export type Options = Flags<typeof FLAGS>;

export type Verb = 'start' | 'next' | 'done';

const VERBS: readonly Verb[] = ['start', 'next', 'done'];

/** Share caller, cursor and refusals across verbs rather than duplicating the protocol. */
export function parseArgs(argv: readonly string[]): { verb: Verb; opts: Options } | undefined {
  const [head, ...rest] = argv;
  const verb = VERBS.find((known) => known === head);
  if (verb === undefined) {
    return undefined;
  }
  const opts = parseFlags(rest, FLAGS, BARE);
  return opts ? { verb, opts } : undefined;
}

function die(code: number, message: string): never {
  process.stderr.write(`squadron-step: ${message}\n`);
  process.exit(code);
}

/**
 * What the record was, as three cases rather than a value and a hole.
 *
 * `readProgress` answers `undefined` for both an absent file and a corrupt one,
 * and those are not the same thing to a caller: the first means no workflow is
 * running here, the second means one is and its record is unreadable. Told
 * apart here so {@link stepPlan} can decide both purely, and so exit 5 is
 * reachable at all.
 */
export type RunRead =
  { state: 'missing' } | { state: 'unusable' } | { state: 'ok'; progress: Progress };

/** One lane `next` is about to open. The pid comes back from the window. */
export type LaneStart = {
  lane: string;
  /** The arming's token, written into `lanes` before the spawn and put in its command. */
  openedAt: number;
  request: OpenSessionRequest;
  /** What a retry on the anchor's model re-renders the prompt from. */
  retry: { workflowId: string; shell: commands.Shell };
  /** This open is already the one retry, on the anchor's model. */
  fellBack?: true;
  /**
   * Present when the lane stated a pick and this open may be retried once.
   * Empty means the anchor had no effort to send.
   */
  fallback?: { effort?: string };
  /**
   * On the retry, what it falls back from: `<lane>: <pick> could not start
   * (<why>)`. Printed with {@link INSTEAD} when it starts.
   */
  fellFrom?: string;
};

const INSTEAD = " — opened on this session's model instead";

/** A record write, as a value: `performNext` still owes what it opened after one fails. */
export type Written = { ok: true } | { ok: false; code: 2 | 5; reason: string };

/** What a pass of `performOpens` opened. Every return carries it: a child outlives any failure. */
type OpensReport = {
  opened: readonly { lane: string; pid?: number }[];
  notices: readonly string[];
};

export type StepPlan =
  | {
      ok: true;
      out: string;
      unresolved: readonly string[];
      write?: Progress;
      /** `start` writes a *new* run outright. Every other write merges its
       *  steps onto the record as it stands, and refuses if the run changed
       *  underneath — which is precisely what arming a new one intends to do. */
      replace?: true;
      /**
       * Lanes to open before this call serves or waits. `performNext` writes
       * each pid into `lanes` and plans again, so a crash cannot open the same
       * lane twice.
       */
      opens?: readonly LaneStart[];
      /**
       * Sessions to end before those opens. Already authorised by `endPlan`:
       * an idle child whose picked model never started its lane.
       */
      ends?: readonly Session[];
      /** Registered instead of serving. The blocked step stays pending. */
      wait?: WaitRecord;
    }
  | { ok: false; code: number; reason: string };

export function stepPlan(input: {
  verb: Verb;
  caller: string | undefined;
  /** The shell the caller runs the commands this prints. */
  shell: commands.Shell;
  read: RunRead;
  /** Only `next` needs one — `done` records a step whose file may be gone. */
  workflow?: Workflow;
  note?: string;
  /** `start` only: the id as typed, so an unknown one is told apart from none. */
  workflowId?: string;
  force?: boolean;
  cwd: string;
  now: number;
  /** `start --lane` only. Absent on an anchor start. */
  lane?: string;
  anchor?: string;
  /** `start --lane` only: the token the anchor put in this lane's command. */
  opened?: number;
  /** The anchor's record, already read. `start --lane` refuses from it. */
  anchorRun?: RunRead;
  /** `next` in a run with lanes: the other records of this run, and the board it may ask. */
  others?: readonly Progress[];
  sessions?: readonly Session[];
  targetContext?: TargetContext;
  /** The caller's pid, from the board. Stamped onto an anchor that has none. */
  pid?: number;
  /** Set when the board could not be loaded. Used only if this call must open or wait. */
  boardRefused?: { code: 3; reason: string };
  /** Read only when a lane is open: `decideNext` fills a lane's pid from it and proves pids by it. */
  lineage?: ReadonlyMap<number, SpawnEdge>;
  /** The fan-out a lane joins, as `squadron-spawn` would stamp it. */
  origin?: string;
}): StepPlan {
  if (input.caller === undefined || input.caller === '') {
    return {
      ok: false,
      code: 2,
      reason: `this command could not tell which session is calling it; pass --caller-session-id <sessionId>\n${USAGE}`
    };
  }
  // `start` needs no existing run. The missing-record guard must follow it.
  if (input.verb === 'start') {
    return planStart(input);
  }
  if (input.read.state === 'missing') {
    return {
      ok: false,
      code: 2,
      reason: `no workflow is running at this session — if you were told to follow one, arm it with \`${stepCommand(input.shell, 'start', '--workflow-id')} <id>\``
    };
  }
  if (input.read.state === 'unusable') {
    return { ok: false, code: 5, reason: 'the record for this run is there and could not be read' };
  }
  const progress = input.read.progress;
  if (input.verb === 'done') {
    return planDone(completeCurrent(progress, { note: input.note, now: input.now }), input.shell);
  }
  if (!input.workflow) {
    // Invalid and deleted definitions both leave nothing to serve.
    return {
      ok: false,
      code: 2,
      reason: 'the workflow this run follows is no longer on this machine, or no longer valid'
    };
  }
  const decided = decideNext({
    progress,
    workflow: input.workflow,
    cwd: input.cwd,
    shell: input.shell,
    now: input.now,
    others: input.others,
    sessions: input.sessions,
    boardRefused: input.boardRefused,
    pid: input.pid,
    lineage: input.lineage
  });
  return planOf(decided, progress, input.workflow, input);
}

/**
 * Arm a run at the calling session.
 *
 * This is what makes a failed seed self-healing. The host seeds at send time,
 * when a brand may not have stated its session id yet — `host/sessions.ts`
 * records a measured Grok case where a child drove three steps into a record no
 * card could find. An agent running this cannot hit that race: by the time it
 * calls, `ownSessionId` answers. And it gets an exit code, where a message
 * composed host-side can only degrade quietly.
 */
function planStart(input: {
  shell: commands.Shell;
  caller: string | undefined;
  read: RunRead;
  workflow?: Workflow;
  workflowId?: string;
  force?: boolean;
  now: number;
  lane?: string;
  anchor?: string;
  opened?: number;
  anchorRun?: RunRead;
}): StepPlan {
  if (input.workflowId === undefined || input.workflowId === '') {
    return { ok: false, code: 1, reason: `a --workflow-id <id> is required\n${USAGE}` };
  }
  if (!input.workflow) {
    return { ok: false, code: 2, reason: noSuchWorkflow(input.workflowId) };
  }
  // Replacing a live run discards its cursor. The record has no history to restore.
  if (input.read.state !== 'missing' && !input.force) {
    const running =
      input.read.state === 'ok'
        ? (input.read.progress.label ?? input.read.progress.workflowId)
        : 'one';
    return {
      ok: false,
      code: 2,
      reason: `a run is already at this session (${running}) — pass --force to replace it`
    };
  }
  const workflow = input.workflow;
  const named = input.lane === undefined || input.lane === '' ? undefined : input.lane;
  if (named !== undefined) {
    const anchor = input.anchor;
    if (anchor === undefined || anchor === '') {
      return {
        ok: false,
        code: 1,
        reason: `a --anchor-session-id <sessionId> is required with --lane\n${USAGE}`
      };
    }
    if (input.opened === undefined) {
      return { ok: false, code: 1, reason: `an --opened <n> is required with --lane\n${USAGE}` };
    }
    if (!input.anchorRun || input.anchorRun.state === 'missing') {
      return { ok: false, code: 2, reason: `no workflow is running at anchor ${anchor}` };
    }
    if (input.anchorRun.state === 'unusable') {
      return { ok: false, code: 5, reason: 'the anchor record is there and could not be read' };
    }
    const anchorRecord = input.anchorRun.progress;
    const miss = armingMiss(anchorRecord, {
      workflowId: workflow.id,
      lane: named,
      opened: input.opened
    });
    if (miss === 'cancelled') {
      return { ok: false, code: 2, reason: "the anchor's run was cancelled from the panel" };
    }
    if (miss === 'workflow') {
      return {
        ok: false,
        code: 2,
        reason: `the anchor follows ${anchorRecord.workflowId}, not ${workflow.id}`
      };
    }
    if (!workflow.steps.some((step) => graph.laneOf(step) === named)) {
      return { ok: false, code: 2, reason: `${workflow.id} has no lane ${named}` };
    }
    // Copying the current token would let an earlier arming's slow child adopt this run.
    if (miss === 'opened') {
      return {
        ok: false,
        code: 2,
        reason: `the anchor did not open ${named} for the run it is on now — this start belongs to an earlier one`
      };
    }
  }
  // `graph.ARMED` is not stored, preserving the pre-lane record shape.
  const laneSeed = named ?? graph.ARMED;
  if (
    laneSeed === graph.ARMED &&
    !workflow.steps.some((step) => graph.laneOf(step) === graph.ARMED)
  ) {
    return { ok: false, code: 2, reason: ARMED_LANE_EMPTY };
  }
  const unopened = laneSeed === graph.ARMED ? authoring.unopenedLanes(workflow.steps) : [];
  if (unopened.length > 0) return { ok: false, code: 2, reason: unopened.join('; ') };
  const progress = seedProgress({
    sessionId: input.caller ?? '',
    workflowId: workflow.id,
    label: workflow.label,
    steps: workflow.steps,
    now: input.now,
    lane: laneSeed,
    ...(named !== undefined && input.anchor ? { anchor: input.anchor, opened: input.opened } : {})
  });
  return {
    ok: true,
    out: `Following "${workflow.label}" (${workflow.id}), ${progress.steps.length} steps. Run \`${stepCommand(input.shell, 'next')}\` for the first one.`,
    unresolved: [],
    write: progress,
    replace: true
  };
}

/**
 * Authorise ends and waits before effects. Pass an open's or wait's write
 * only when the record moved. A serve's write is compared by `performNext`.
 */
function planOf(
  decided: NextDecision,
  progress: Progress,
  workflow: Workflow,
  input: Parameters<typeof stepPlan>[0]
): StepPlan {
  if (decided.kind === 'refuse') {
    return { ok: false, code: decided.code, reason: decided.reason };
  }
  if (decided.kind === 'serve') {
    return { ok: true, out: decided.out, unresolved: decided.unresolved, write: decided.write };
  }
  const sessions = input.sessions ?? [];
  const write = decided.write !== progress ? { write: decided.write } : {};
  if (decided.kind === 'wait') {
    const planned = waitPlan(
      decided.pids,
      sessions,
      input.caller ?? '',
      input.now,
      input.targetContext
    );
    if (!planned.ok) return planned;
    const wait: WaitRecord = {
      ...planned.record,
      workflow: {
        workflowId: decided.write.workflowId,
        ...(decided.write.armedAt === undefined ? {} : { armedAt: decided.write.armedAt })
      }
    };
    return {
      ok: true,
      out: `${registered(wait).trimEnd()}\nWhen you are woken, run \`${stepCommand(input.shell, 'next')}\`.`,
      unresolved: [],
      ...write,
      wait
    };
  }
  const ends: Session[] = [];
  for (const pid of decided.ends) {
    const authorised = endPlan({ pid }, sessions, progress.sessionId);
    if (!authorised.ok) return { ok: false, code: 2, reason: authorised.reason };
    ends.push(...authorised.members);
  }
  const anchorEffort = sessions.find((session) => session.sessionId === progress.sessionId)?.effort;
  return {
    ok: true,
    out: '',
    unresolved: [],
    opens: decided.opens.map((open) =>
      laneStart(workflow, open.lane, {
        anchorId: progress.sessionId,
        shell: input.shell,
        cwd: input.cwd,
        openedAt: input.now,
        origin: input.origin,
        anchorEffort,
        ...(open.fellBack ? { fellBack: true as const, why: 'never started its lane' } : {})
      })
    ),
    ...(ends.length > 0 ? { ends } : {}),
    ...write
  };
}

function laneStart(
  workflow: Workflow,
  lane: string,
  at: {
    anchorId: string;
    /** The anchor's, which a lane naming no brand inherits. */
    shell: commands.Shell;
    cwd: string;
    openedAt: number;
    origin?: string;
    anchorEffort?: string;
    fellBack?: true;
    why?: string;
  }
): LaneStart {
  const step = graph.opener(workflow.steps, lane);
  const fellBack = at.fellBack === true;
  // A lane naming its brand runs that CLI; otherwise, and on the retry, the anchor's.
  const shell = !fellBack && step?.brand ? toolShell(step.brand) : at.shell;
  const prompt = lanePrompt(shell, workflow.id, lane, at.anchorId, at.openedAt);
  const pick = pickName(step);
  return {
    lane,
    openedAt: at.openedAt,
    retry: { workflowId: workflow.id, shell: at.shell },
    ...(fellBack ? { fellBack: true as const } : {}),
    ...(fellBack && pick !== undefined && at.why
      ? { fellFrom: `${lane}: ${pick} could not start (${at.why})` }
      : {}),
    ...(!fellBack && pick !== undefined
      ? { fallback: { ...(at.anchorEffort ? { effort: at.anchorEffort } : {}) } }
      : {}),
    request: {
      cwd: at.cwd,
      prompt,
      name: lane,
      parentSessionId: at.anchorId,
      from: at.anchorId,
      ...(at.origin ? { originSessionId: at.origin } : {}),
      // No workflowId. The host treats one as `squadron-spawn --workflow-id` and
      // seeds every step before this prompt runs, so `start --lane` then
      // refuses with a run already here. The id is in the prompt's `start`.
      ...(fellBack
        ? at.anchorEffort
          ? { effort: at.anchorEffort }
          : {}
        : {
            ...(step?.brand ? { brand: step.brand } : {}),
            ...(step?.model ? { model: step.model } : {}),
            ...(step?.effort ? { effort: step.effort } : {})
          })
    }
  };
}

/**
 * A completion, and the one instruction that keeps the loop turning.
 *
 * **`Recorded "x" completed.` alone stalls half of all runs.** Measured
 * 2026-09-17 over every transcript on this machine: 969 `done` calls, ~102 of
 * which were the last step the session ever took — it reported to the reader
 * and ended its turn — and 77 of 143 runs stalled at least once. Two sessions
 * named the cause themselves when the confirm chip asked: *"I marked step 7
 * done and stopped there without calling `next`"*.
 *
 * **Owed: that count, re-read.** Same query over `~/.claude/projects`, filtered
 * to runs started after this ships — pre-fix stalls would otherwise swamp the
 * corpus — and not until ~40-50 post-deploy runs have accumulated, since 143 is
 * a figure that took real time. `src/test/live_session/workflow_step_pull.md`
 * row 2b guards the transition per run; it is not this.
 *
 * It is step-blind's own bill: the agent used to read the whole file, so "there
 * are three more" lived in its own context, and now the only thing that says so
 * is `progressBriefing` — delivered once, at the top of the run. So the line
 * carries turn control, which is `squadron-wait`'s trick ("End your turn
 * now… do not poll") and the reason that one never stalls.
 *
 * **It says the same thing on the last step**: `next` owns completion, and the
 * record's rows lag a definition edited mid-run, so this verb cannot tell
 * without reading one it deliberately does not.
 *
 * No tally rides along. A count here would be off the record where
 * `stepHeader`'s is off the definition — two denominators for one run — and
 * `3 of 3` is the most terminal thing that could be appended to a sentence
 * whose whole job is to stop `done` reading as a full stop.
 */
function planDone(result: CompleteResult, shell: commands.Shell): StepPlan {
  if (result.outcome === 'blocked') {
    return { ok: false, code: 2, reason: result.reason };
  }
  return {
    ok: true,
    out: `Recorded "${result.id}" completed. Run \`${stepCommand(shell, 'next')}\` now, before you report anything back: it serves the next step, confirms the run is over, or explains why it cannot continue.`,
    unresolved: [],
    write: result.progress
  };
}

async function readRun(sessionId: string): Promise<RunRead> {
  const progress = await readProgress(sessionId);
  if (progress) {
    return { state: 'ok', progress };
  }
  const there = await fs.stat(progressPath(sessionId)).then(
    () => true,
    () => false
  );
  return there ? { state: 'unusable' } : { state: 'missing' };
}

/**
 * Re-read before merging: writing the snapshot whole would erase a cancellation,
 * and merging into a newly armed workflow would misattribute the steps.
 * `mergeOnto` carries only fields this command owns.
 */
async function commit(planned: Progress): Promise<Written> {
  const fresh = await readProgress(planned.sessionId);
  if (!fresh) {
    return unwritten(5, 'the record for this run went away while this command was deciding');
  }
  const moved = runMoved(fresh, planned);
  if (moved === 'cancelled') {
    return unwritten(2, 'this run was cancelled from the panel');
  }
  if (moved === 'workflow') {
    return unwritten(2, `a different workflow (${fresh.workflowId}) was armed at this session`);
  }
  if (moved === 'armed') {
    return unwritten(
      2,
      'this workflow was armed again at this session while this command was deciding'
    );
  }
  const written = await writeProgress(mergeOnto(fresh, planned));
  // `writeAtomicJson` returns false rather than throwing, so without this the
  // command exits 0 having recorded nothing.
  return written ? { ok: true } : unwritten(5, 'the record for this run could not be written');
}

function unwritten(code: 2 | 5, reason: string): Written {
  return { ok: false, code, reason };
}

/**
 * List every field this command writes or the merge drops it. Replace `held`
 * even when absent: a plan without it resets the wait count.
 */
export function mergeOnto(fresh: Progress, planned: Progress): Progress {
  const { held: _replaced, ...rest } = fresh;
  return {
    ...rest,
    steps: planned.steps,
    updatedAt: planned.updatedAt,
    ...(planned.pid !== undefined ? { pid: planned.pid } : {}),
    ...(planned.lanes !== undefined ? { lanes: planned.lanes } : {}),
    ...(planned.held !== undefined ? { held: planned.held } : {})
  };
}

async function replace(planned: Progress): Promise<Written> {
  return (await writeProgress(planned))
    ? { ok: true }
    : unwritten(5, 'the record for this run could not be written');
}

/**
 * Open each lane: its entry is written before the spawn and its pid after.
 *
 * The entry first, because it is what stops a second open — a crash, or a
 * window that never answers, leaves the lane in `lanes` rather than openable
 * again. Only silence keeps it, with the `requestId` that finds it in
 * `lineage/`: a refusal, no window, or a request that could not be written
 * opened nothing, so the entry goes and the next call may try again. Each write
 * is awaited so the next spawn cannot start until it is on disk.
 *
 * A `cause: 'pick'` refusal of a lane that stated a pick is opened again at
 * once, with no brand and no model. The new `openedAt` is one later than the
 * claim just written: the plan's `now` is this same instant, and a late child
 * of the first open is an earlier arming only when the tokens differ. A pick
 * refusal of that retry is final, so the claim stays with `fellBack` — dropping
 * it would open the original model again — and `refused`. Fleet, no window and an unwritable retry are not the pick: the claim goes,
 * as it does today, and the next call may try again. Silence keeps the
 * `requestId` either way.
 */
export async function performOpens(
  record: Progress,
  opens: readonly LaneStart[],
  open: (request: OpenSessionRequest) => Promise<OpenSessionResult>,
  now: number,
  write: (progress: Progress) => Promise<Written>,
  reread: () => Promise<Progress | undefined>
): Promise<
  | ({ ok: true; progress: Progress } & OpensReport)
  | ({ ok: false; code: 2 | 3 | 4 | 5; reason: string } & OpensReport)
> {
  let current = record;
  const sync = async (): Promise<boolean> => {
    const fresh = await reread();
    if (fresh?.lanes) current = { ...current, lanes: fresh.lanes };
    return fresh !== undefined && runMoved(fresh, record) !== undefined;
  };
  const put = async (lane: string, entry: LaneOpen | undefined): Promise<Written> => {
    await sync();
    const { [lane]: _prior, ...rest } = current.lanes ?? {};
    current = { ...current, lanes: entry ? { ...rest, [lane]: entry } : rest, updatedAt: now };
    return write(current);
  };
  const opened: { lane: string; pid?: number }[] = [];
  const notices: string[] = [];
  const stop = (failure: { code: 2 | 3 | 4 | 5; reason: string }) => ({
    ok: false as const,
    code: failure.code,
    reason: failure.reason,
    opened,
    notices
  });
  const moved = {
    code: 2 as const,
    reason: 'this run was cancelled or armed again while a lane was being opened'
  };
  // `constructor` is inherited from Object.prototype, not an authored lane claim.
  const laneClaim = (lane: string): LaneOpen | undefined => {
    const lanes = current.lanes;
    if (lanes === undefined || !Object.hasOwn(lanes, lane)) return undefined;
    return lanes[lane];
  };
  for (const start of opens) {
    // A second `next` beside this one planned off the same record, so each lane
    // is checked on disk before it is claimed and again after. Not a lock: two
    // calls inside the same few milliseconds can still both open it.
    //
    // A fallback replaces the claim it is falling back from. Skipping any
    // existing entry would leave that failed child in place: `sync` reads the
    // lane back off disk, and the plan's stripped copy does not survive it.
    await sync();
    const prior = laneClaim(start.lane);
    if (prior?.fellBack) continue;
    if (prior && !start.fellBack) continue;
    const flag = start.fellBack ? { fellBack: true as const } : {};
    const claimed = await put(start.lane, { openedAt: start.openedAt, ...flag });
    if (!claimed.ok) return stop(claimed);
    // Check again after the write, before a child exists.
    if (await sync()) return stop(moved);
    if (laneClaim(start.lane)?.openedAt !== start.openedAt) continue;
    let attempt = start;
    let result = await open(start.request);
    if (!result.ok && result.cause === 'pick' && start.fallback && !start.fellBack) {
      attempt = retryOf(start, result.reason);
      const reclaimed = await put(start.lane, { openedAt: attempt.openedAt, fellBack: true });
      if (!reclaimed.ok) return stop(reclaimed);
      if (await sync()) return stop(moved);
      if (laneClaim(start.lane)?.openedAt !== attempt.openedAt) continue;
      result = await open(attempt.request);
    }
    const settled = {
      openedAt: attempt.openedAt,
      ...(attempt.fellBack ? { fellBack: true as const } : {})
    };
    const requestId = result.requestId === undefined ? {} : { requestId: result.requestId };
    if (!result.ok && attempt.fellBack && result.cause === 'pick') {
      const refused = `${attempt.fellFrom ?? attempt.lane}, and neither could this session's model (${result.reason})`;
      const wrote = await put(start.lane, { ...settled, refused });
      return stop(alongside({ code: result.code, reason: refused }, wrote));
    }
    if (!result.ok) {
      const wrote = await put(
        start.lane,
        result.code === 4 ? { ...settled, ...requestId } : undefined
      );
      return stop(alongside(result, wrote));
    }
    opened.push({ lane: start.lane, ...(result.pid === undefined ? {} : { pid: result.pid }) });
    if (attempt.fellFrom) notices.push(attempt.fellFrom + INSTEAD);
    // The `requestId` is kept either way: with no pid it is how the next call
    // finds the lane, and with one it is how a later call proves the pid is
    // still this lane's (`waitTargets`). No pid is not refused — the lane did
    // open, and refusing now would strand it.
    const recorded = await put(start.lane, {
      ...settled,
      ...requestId,
      ...(result.pid === undefined ? {} : { pid: result.pid })
    });
    if (!recorded.ok) return stop(recorded);
  }
  return { ok: true, progress: current, opened, notices };
}

/**
 * A failed open whose outcome could not be written: both reasons, and the
 * write's code, as a machine that cannot record outranks a refusal. Only 4 stands:
 * it says a session may have started.
 */
function alongside(
  failure: { code: 2 | 3 | 4 | 5; reason: string },
  wrote: Written
): { code: 2 | 3 | 4 | 5; reason: string } {
  if (wrote.ok) return failure;
  return {
    code: failure.code === 4 ? 4 : wrote.code,
    reason: `${failure.reason}\n${wrote.reason}`
  };
}

/** The opened lane's first turn: arm the lane, then pull its first step. */
function lanePrompt(
  shell: commands.Shell,
  workflowId: string,
  lane: string,
  anchorId: string,
  openedAt: number
): string {
  return (
    `\`${stepCommand(shell, 'start', '--workflow-id', workflowId, '--lane', lane, '--anchor-session-id', anchorId, '--opened', openedAt)}\`, ` +
    `then \`${stepCommand(shell, 'next')}\`.`
  );
}

/** The retry runs on the anchor's CLI, so its prompt is rendered for the anchor's shell. */
function retryOf(start: LaneStart, reason: string): LaneStart {
  const retryAt = start.openedAt + 1;
  const { brand, model, effort, ...kept } = start.request;
  return {
    lane: start.lane,
    openedAt: retryAt,
    retry: start.retry,
    fellBack: true,
    fellFrom: `${start.lane}: ${pickName(start.request)} could not start (${reason})`,
    request: {
      ...kept,
      prompt: lanePrompt(
        start.retry.shell,
        start.retry.workflowId,
        start.lane,
        kept.parentSessionId ?? '',
        retryAt
      ),
      ...(start.fallback?.effort !== undefined ? { effort: start.fallback.effort } : {})
    }
  };
}

export type NextIo = {
  closeOne: typeof closeOne;
  openSession: (request: OpenSessionRequest) => Promise<OpenSessionResult>;
  commit: (planned: Progress) => Promise<Written>;
  replace: (planned: Progress) => Promise<Written>;
  writeWait: (record: WaitRecord) => Promise<boolean>;
  reread: (sessionId: string) => Promise<Progress | undefined>;
  readLineage: () => Promise<ReadonlyMap<number, LineageEntry>>;
};

/**
 * `next`: plan, end and open what the plan says, and plan again until a plan
 * opens nothing new.
 *
 * A fallback plan opens only the lanes falling back, so the lanes readiness
 * finds are seen by the plan after it. Each later plan reads the record the
 * opens wrote and a fresh lineage, which names the pid of a lane its window
 * never answered for. It keeps `now`, the sibling records and the board: a
 * lane opened a moment ago is fresh at that `now`, so a board that has not
 * seen it yet does not read it as gone.
 */
export async function performNext(
  fields: Omit<Parameters<typeof stepPlan>[0], 'lineage'>,
  io: NextIo
): Promise<
  | { ok: true; out: string; unresolved: readonly string[] }
  | { ok: false; code: number; reason: string }
> {
  const progress = fields.read.state === 'ok' ? fields.read.progress : undefined;
  // Read once a lane is open: it names a lane the window never gave a pid for,
  // and proves a recordless lane's pid is still its.
  const lineageFor = async (record: Progress | undefined) => {
    const opened = [record, ...(fields.others ?? [])].some(
      (each) => Object.keys(each?.lanes ?? {}).length > 0
    );
    return fields.others !== undefined && opened ? io.readLineage() : undefined;
  };
  let plan = stepPlan({ ...fields, lineage: await lineageFor(progress) });
  if (!plan.ok) return plan;

  let current = progress;
  const notices: string[] = [];
  const named: string[] = [];
  const opened = new Set<string>();
  const openedLine = () =>
    named.length === 0
      ? ''
      : `${notices.map((line) => `${line}\n`).join('')}Opened ${named.join(', ')}.\n`;
  const refuse = (failure: { code: number; reason: string }) => ({
    ok: false as const,
    code: failure.code,
    reason: `${openedLine()}${failure.reason}`
  });
  // Lanes are finite and each pass opens one not opened before, so this ends.
  // A plan re-listing only opened lanes cannot happen at this `now` — a lane
  // opened at it is fresh and claimed — and is left unperformed if it does.
  while (plan.opens?.some((start) => !opened.has(start.lane))) {
    const opens = plan.opens;
    for (const member of plan.ends ?? []) {
      const closed = await io.closeOne(member);
      if (!closed.ok) {
        return refuse({ code: askExit(closed), reason: closed.reason });
      }
    }
    const base = plan.write ?? current;
    if (!base) {
      return refuse({
        code: 5,
        reason: 'the record for this run went away while this command was deciding'
      });
    }
    const done = await performOpens(base, opens, io.openSession, fields.now, io.commit, () =>
      io.reread(base.sessionId)
    );
    notices.push(...done.notices);
    named.push(...done.opened.map(({ lane, pid }) => `${lane} (pid ${pid ?? 'not yet known'})`));
    if (!done.ok) return refuse(done);
    for (const start of opens) opened.add(start.lane);
    current = done.progress;
    plan = stepPlan({
      ...fields,
      read: { state: 'ok', progress: done.progress },
      pid: done.progress.pid ?? fields.pid,
      lineage: await lineageFor(done.progress)
    });
    if (!plan.ok) return refuse(plan);
  }
  if (plan.wait && !(await io.writeWait(plan.wait))) {
    return refuse({ code: 5, reason: 'could not write the wait' });
  }
  // **Identity, not deep equality, and before the merge.** `serveNext` returns
  // the record it was given when nothing moved, so a repeated `next` on an
  // unchanged run has nothing to write. Writing it anyway refreshes the file's
  // mtime — and `workflowCompletion` dates its tally on mtime rather than
  // `updatedAt`, so a reprint would un-retire a tally the reader had already
  // acked. The comparison has to happen here, because `commit`'s re-read
  // replaces the object it would be compared against.
  if (plan.write && plan.write !== current) {
    const wrote = await (plan.replace ? io.replace(plan.write) : io.commit(plan.write));
    if (!wrote.ok) return refuse(wrote);
  }
  return { ok: true, out: `${openedLine()}${plan.out}`, unresolved: plan.unresolved };
}

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-step');
  if (help.show('step', USAGE, argv)) return;
  const parsed = parseArgs(argv);
  if (!parsed) {
    die(1, usageFor(argv, USAGE, RENAMED));
  }
  await gate.refuseUnlessOn('step');
  const { verb, opts } = parsed;
  const caller = opts['caller-session-id'] ?? ownSessionId(process.env);
  const read = caller ? await readRun(caller) : { state: 'missing' as const };
  const progress = read.state === 'ok' ? read.progress : undefined;

  // `start` resolves the id the caller typed; `next` resolves the one the
  // record already follows. `done` needs no definition at all, which is what
  // lets a run whose file was deleted still record its last step.
  const wanted =
    verb === 'start' ? opts['workflow-id'] : verb === 'next' ? progress?.workflowId : undefined;
  const workflow = wanted ? (await readWorkflows()).find((w) => w.id === wanted) : undefined;
  const now = Date.now();
  const cwd = path.resolve(process.cwd());
  const namedLane = opts.lane === undefined || opts.lane === '' ? undefined : opts.lane;
  const anchor = opts['anchor-session-id'];
  const namedAnchor = anchor === undefined || anchor === '' ? undefined : anchor;
  const opened = opts.opened === undefined ? undefined : Number(opts.opened);
  if (opened !== undefined && !Number.isSafeInteger(opened)) {
    die(1, `--opened takes the number the anchor put in your command\n${USAGE}`);
  }
  const anchorRun =
    verb === 'start' && namedLane !== undefined && namedAnchor !== undefined
      ? await readRun(namedAnchor)
      : undefined;

  // A file that names no lane never reads the board: a failed load would be a
  // new way for `next` to die, and that path asks no window. One that names a
  // lane loads it and only dies with the board's code when it is about to open
  // a lane or register a wait.
  let others: Progress[] | undefined;
  let sessions: Session[] | undefined;
  let targetContext: TargetContext | undefined;
  let pid: number | undefined;
  let boardRefused: { code: 3; reason: string } | undefined;
  if (verb === 'next' && workflow && graph.hasLanes(workflow.steps) && progress) {
    others = await readRunRecords(progress);
    const board = await loadBoard();
    if (!board.ok) {
      boardRefused = { code: board.code, reason: board.reason };
    } else {
      sessions = board.sessions;
      targetContext = board;
      pid = board.sessions.find((session) => session.sessionId === caller)?.pid;
    }
  }

  const fields = {
    verb,
    caller,
    // Whose tool runs this verb is whose shell runs what it prints.
    shell: toolShell(ownBrand(process.env)),
    read,
    workflow,
    workflowId: opts['workflow-id'],
    force: opts.force !== undefined,
    note: opts.note,
    cwd,
    now,
    others,
    sessions,
    targetContext,
    pid,
    boardRefused,
    origin: resolveOrigin({}, process.env),
    ...(verb === 'start' ? { lane: namedLane, anchor: namedAnchor, opened, anchorRun } : {})
  };
  if (verb === 'next') {
    const done = await performNext(fields, {
      closeOne: (member) => closeOne(member, targetContext),
      openSession,
      commit,
      replace,
      writeWait,
      reread: readProgress,
      readLineage
    });
    if (!done.ok) {
      die(done.code, done.reason);
    }
    report(done);
    return;
  }
  const plan = stepPlan(fields);
  if (!plan.ok) {
    die(plan.code, plan.reason);
  }
  if (plan.write && plan.write !== progress) {
    const wrote = await (plan.replace ? replace(plan.write) : commit(plan.write));
    if (!wrote.ok) {
      die(wrote.code, wrote.reason);
    }
  }
  report(plan);
}

function report(said: { out: string; unresolved: readonly string[] }): void {
  if (said.unresolved.length > 0) {
    // Emptying an unresolved reference hides the fault in an apparently complete instruction.
    process.stderr.write(
      `squadron-step: this step names ${said.unresolved.join(', ')}, which nothing here could fill in\n`
    );
  }
  process.stdout.write(`${said.out}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    die(5, error instanceof Error ? error.message : String(error));
  });
}
