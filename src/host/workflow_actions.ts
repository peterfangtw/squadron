/**
 * Workflow action verbs.
 */
import {
  deleteWorkflow as deleteWorkflowFile,
  duplicateWorkflow as duplicateWorkflowFile,
  saveWorkflow as saveWorkflowFile
} from '../core/workflows/workflows';
import { writeWorkflowOrder as writeOrder } from '../core/workflows/workflow_order';
import {
  cancelProgress,
  forgetProgress,
  readProgress,
  rollup,
  stepMarker
} from '../core/workflows/progress';
import { ownedSession } from './sessions';
import { PanelActions } from './panel_actions';
import { sameSessionStart } from '../core/model';
/** What a cancelled run is told, in the same voice `progressBriefing` set the
 *  rule in. Both halves are load-bearing: the interrupt beside it ends a turn
 *  and not an instruction, so without the first sentence the agent resumes the
 *  pipeline on its next prompt — and without the second it keeps editing a file
 *  whose `cancelledAt` is the only thing keeping the chip down.
 *
 *  "update", not "write": `test/fixtures/fake-cli.ts` scripts its turns off
 *  `text.includes('write')`, so that word in a line the panel sends of its own
 *  accord opens a permission dialog in the smoke host and wedges every scenario
 *  behind it. The fixture is right to match loosely — it is standing in for a
 *  model — and this reads no worse for it. */
const CANCELLED_RUN =
  'Stop the workflow you were given. Do not start any further steps, and do not update the progress file again.';

/** What a stopped run is told when the reader presses Retry / Continue — a
 *  run marked `failed` included, since the chip no longer tells it apart.
 *
 *  A step served by `squadron-step` is `in_progress` from the moment it is
 *  handed over until `done`, and nothing writes `failed` any more — so a stalled
 *  step and one being worked look identical from here, and `stepMarker` paints
 *  both `working`. Rather than guess, the session is handed the question: it is
 *  the only party that knows which it is.
 *
 *  Four answers and not a yes/no, because the useful ones are not opposites —
 *  a record that is behind and an agent that is stuck want different repairs,
 *  and "I can carry on alone" is the one the reader most wants offered before
 *  being interrupted. The same avoided word as above. */
const confirmRun = (step: string | undefined): string =>
  `Check ${step === undefined ? 'the step you stopped on in' : `the "${step}" step of`} the workflow you were given, and say which of these is true before you start anything else: you are still on it; you finished it and the record is behind; you are stuck on it and can carry on by yourself; or you are stuck and need a person. From outside, a step in flight and a stalled one look identical — you are the only one who can tell them apart, so this is a question rather than an instruction.`;

/**
 * Create or update a workflow file from the board editor. Validation is the
 * same gate `readWorkflows` uses; a refusal leaves disk alone and returns
 * reasons to the form.
 */
export async function saveWorkflow(panel: PanelActions, msg: WorkflowDraft): Promise<void> {
  try {
    const result = await saveWorkflowFile({
      id: msg.id,
      label: msg.label,
      lanes: msg.lanes,
      steps: msg.steps
    });
    if (result.ok) {
      panel.post({ type: 'saveWorkflowResult', ok: true, id: result.workflow.id });
      void panel.refresh();
      return;
    }
    panel.post({ type: 'saveWorkflowResult', ok: false, reasons: result.reasons });
  } catch (err) {
    // Always answer the form — an unhandled rejection leaves Save on “Saving…”.
    panel.post({
      type: 'saveWorkflowResult',
      ok: false,
      reasons: [err instanceof Error ? err.message : 'could not save workflow']
    });
  }
}

/**
 * A successful copy appears in the next poll's list. Only refusal needs
 * a result, and `saveWorkflowResult` already carries it.
 */
export async function duplicateWorkflow(panel: PanelActions, msg: { id: string }): Promise<void> {
  try {
    const result = await duplicateWorkflowFile(msg.id);
    if (result.ok) {
      void panel.refresh();
      return;
    }
    panel.post({ type: 'saveWorkflowResult', ok: false, reasons: result.reasons });
  } catch (err) {
    panel.post({
      type: 'saveWorkflowResult',
      ok: false,
      reasons: [err instanceof Error ? err.message : 'could not duplicate workflow']
    });
  }
}

/**
 * Writes what the reader has stated about the list.
 *
 * Nothing is posted back on either outcome. The next poll carries the folded
 * list, which is the answer.
 *
 * **A failed write is therefore not reported, and the sheet does not find out.**
 * It draws a move as a draft the moment the reader makes one, and `settleDraft`
 * (`webview/workflows_mode.ts`) drops that draft only when a push agrees with it — so a
 * disk that would not take the order leaves the sheet drawing a move no file
 * says, until it is closed. Named here rather than fixed: the alternative is a
 * give-up with a clock in it, on a path that has burnt this branch twice
 * already, and nothing has yet met a disk that refuses. Best effort, exactly as
 * an arrangement is.
 */
export async function writeWorkflowOrder(
  panel: PanelActions,
  msg: WorkflowOrderStatement
): Promise<void> {
  await writeOrder({ order: msg.order });
  void panel.refresh();
}

/**
 * Delete a workflow file from the board editor. Confirm is webview-side
 * (two clicks on Delete → Confirm delete); the host just unlinks and answers
 * so the form does not stick on “Deleting…”.
 */
export async function deleteWorkflow(panel: PanelActions, msg: { id: string }): Promise<void> {
  try {
    const result = await deleteWorkflowFile(msg.id);
    if (result.ok) {
      panel.post({ type: 'deleteWorkflowResult', ok: true });
      void panel.refresh();
      return;
    }
    panel.post({ type: 'deleteWorkflowResult', ok: false, reasons: result.reasons });
  } catch (err) {
    panel.post({
      type: 'deleteWorkflowResult',
      ok: false,
      reasons: [err instanceof Error ? err.message : 'could not delete workflow']
    });
  }
}

/**
 * Un-follow a workflow whose arming message was thrown away.
 *
 * The message is what carried the briefing, so a dismissed one is a workflow
 * the agent was never told about. `held` is the outbox depth after the
 * dismiss: anything still in there may be the arming message itself, and
 * dropping the file under a message that is about to go out would leave the
 * agent writing to a path nothing reads.
 *
 * This is why the file is unlinked rather than marked: there is no status left
 * to cancel. Without it, arming at a busy session and then dismissing the
 * queued message leaves "Following X" up until the 7-day sweep.
 *
 * **Only a file no agent has touched.** This is where the old record's
 * `armed` was, and `toCancelArmed` retired armed records alone — a workflow
 * already being worked was never orphaned by a dismiss. Without the test, any
 * dismissed message on any session would un-follow the workflow that session
 * is part-way through, which is a worse bug than the one this fixes.
 *
 * The test is not exact, and cannot be: `OwnedSession.send` hands back no id,
 * and the remote reply carries a depth rather than a list, so neither path
 * can say *which* queued message this was. What it can say is that nothing is
 * queued and no step has moved. The one case that misreads is a workflow
 * delivered seconds ago, its agent not yet at step 1, when an unrelated
 * message is dismissed — the file goes, the chip blinks out, and the agent's
 * first write puts it back at the same path. A flicker, not a loss, and the
 * price of the exact answer is a message id across a window boundary.
 */
export async function cancelOrphanedArmed(
  panel: PanelActions,
  pid: number,
  held: number
): Promise<void> {
  if (held > 0) return;
  const session = panel.sessions.find((s) => s.pid === pid);
  if (!session?.sessionId) return;
  const progress = await readProgress(session.sessionId);
  if (!progress?.steps.every((s) => s.status === 'pending')) return;
  await forgetProgress(session.sessionId);
}

/**
 * Stamp cancellation first, so even a run with a dead child clears now.
 * For an unfinished run, interrupt and send `CANCELLED_RUN`: an interrupt
 * ends a turn, not the workflow instruction (see that constant).
 * A done run gets only the stamp, or interrupt could end unrelated work
 * the reader started afterward. Failed runs can still have pending steps.
 * Retrying instead is {@link retryWorkflow}.
 */
export async function cancelWorkflow(
  panel: PanelActions,
  pid: number,
  startedAt: number
): Promise<void> {
  const session = panel.sessions.find((s) => s.pid === pid);
  // Only this window's owned run is this panel's to stamp.
  if (
    session?.source !== 'owned' ||
    !session.sessionId ||
    !sameSessionStart(session.startedAt, startedAt)
  )
    return;
  const owned = ownedSession(pid);
  // Read before stamping: afterward every rollup reads cancelled.
  // `cancelProgress` returns whether the session is free, not what it stamped.
  const progress = await readProgress(session.sessionId);
  await cancelProgress(session.sessionId, Date.now());
  void panel.refresh();

  // Read the file now, rather than using the chip's previous-poll wording.
  if (progress && rollup(progress) === 'done') return;
  if (
    !owned ||
    ownedSession(pid) !== owned ||
    !sameSessionStart(owned.state.startedAt, startedAt) ||
    owned.state.exit !== undefined
  )
    return;
  try {
    await owned.turn?.interrupt();
  } catch {
    // An idle session has no turn to end and says so. The message below is
    // what actually stops the work, and it is sent either way.
  }
  // The stamp is the cancel. A CLI without a message capability gets
  // the stamp alone.
  await owned.messages?.send(CANCELLED_RUN, [], undefined);
  void panel.refresh();
}

/**
 * Ask a session where it stands on the step its run stopped on — the act
 * behind the chip's Retry / Continue, and the reason a run that is not
 * finished is not only dismissable.
 *
 * One act where {@link cancelWorkflow} is three: prose, and no interrupt. The
 * line queues behind whatever the session is doing, like any other message —
 * and if the reader has since started something else, ending *that* is not what
 * they wanted.
 *
 * **It asks rather than edits, under either rollup.** Putting a step back to
 * `in_progress` here would be the panel authoring progress, which is the one
 * thing it does not do (PRD §15) — and it would light the chip blue for work no
 * agent had taken up yet. So the file is read for the step's name and left
 * exactly as it stands.
 *
 * **Two rollups reach this, and both get {@link confirmRun}.** A `failed` run
 * is a pre-CLI one whose agent wrote the word by hand, and may carry no step
 * marker; a `running` run is every pulled one.
 *
 * **Either is only reached when the session is idle.** `rollup` cannot
 * tell an abandoned step from one being worked, because both are `in_progress`;
 * the session's status can, since a busy session is mid-step by definition.
 * That join is not new here — `ui/views.ts` gates `completion` on `idle` for
 * the same reason, and the card has read `stalled · N of M` off it since
 * 2026-08-04. `webview/composer.ts`'s `stopped()` is the same rule, so the
 * checks below are the backstop for a press that arrives against a session
 * which has since taken the step back up.
 *
 * What no reader of this file can know is *why* it stopped — crashed, gave up,
 * forgot, or finished and never said. {@link confirmRun} hands that one
 * question to the session, which is the only party holding it. The panel
 * sequences nothing: it puts a question on the pipe and the session decides.
 *
 * Silent on every refusal, and each one is a chip that should not have offered
 * this: a finished run, a run whose steps are all still pending, a session that
 * is busy or waiting on the reader, a session whose child has gone. The reader
 * is told by the chip on the next poll, which is where they were looking.
 */
export async function retryWorkflow(
  panel: PanelActions,
  pid: number,
  startedAt: number
): Promise<void> {
  const session = panel.sessions.find((s) => s.pid === pid);
  if (
    session?.source !== 'owned' ||
    !session.sessionId ||
    !sameSessionStart(session.startedAt, startedAt)
  )
    return;
  const owned = ownedSession(pid);
  const progress = await readProgress(session.sessionId);
  if (!progress) return;
  const phase = rollup(progress);
  if (phase !== 'failed' && phase !== 'running') return;
  if (session.status !== 'idle') return;
  // Check the marker's tone: all-pending steps have no marker, although
  // `rollup` still calls the run `running`.
  const step = stepMarker(progress);
  if (phase === 'running' && step?.tone !== 'working') return;
  if (
    !owned ||
    ownedSession(pid) !== owned ||
    !sameSessionStart(owned.state.startedAt, startedAt) ||
    owned.state.exit !== undefined
  )
    return;
  // Retry is the message. Without that capability there is no retry.
  // The chip uses the same capability gate.
  await owned.messages?.send(confirmRun(step?.label), [], undefined);
  void panel.refresh();
}
