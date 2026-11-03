import * as skills from './skills';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  adapterFor,
  captureOwned,
  conversationKey,
  ownedTranscript,
  modelsForSession,
  readSessionTranscript,
  reconstructed,
  refusal,
  type OwnedCapture,
  type Sourced
} from '../core/adapter';
import { sessionBrand } from '../core/brands';
import { defaultsWide } from '../core/catalog';
import * as delivery from '../core/delivery';
import { SendTarget, Session } from '../core/model';
import type { StagedProgress } from '../core/workflows/progress';
import {
  followingWorkflow,
  readProgress,
  stageForSend,
  withProgressBriefing
} from '../core/workflows/progress';
import { mediaForExt, writePastedImage } from '../core/pastes';
import { REF_PREFIX, attachmentFile, refFile, readRecordPage } from '../core/record';
import { isMarker, recentUserFrom, type Authored } from '../core/transcript';
import type { ThreadSnapshot } from '../core/thread';
import { ownedSession, ownedSessions, setWarm } from './sessions';
import { configuredPathFor } from './cli_path';
import { render } from './markdown';
import { toolView } from '../ui/activity';
import { proseBlockView } from '../ui/turn_blocks';
import * as streaming from '../ui/streaming';
import * as echoCandidates from '../ui/echo_candidates';
import * as transcriptAttribution from '../core/transcript_attribution';
import { buildLineage, composeThread, type ThreadHalves } from '../ui/views';
import { sameSessionStart } from '../core/model';
import type { ReadWorkflow } from '../core/workflows/workflows';
import { armMention, enrich } from '../core/workflows/workflows';
import { PanelActions } from './panel_actions';
import { routeTo } from './session_lookup';
import { cancelOrphanedArmed } from './workflow_actions';
import { isRefused } from '../core/coordination/route';
import * as paths from '../core/paths';

/**
 * How long a routine confirmation sits in the status bar.
 *
 * The status bar rather than a notification, for every confirmation of
 * something the board or the dock is about to show anyway: a toast has to be
 * dismissed, and a reader who mutes the stream to stop dismissing them mutes
 * the panel's refusals along with them.
 */
export const STATUS_MS = 3000;

/**
 * The most an image is allowed to weigh before the dock stops inlining it, as
 * characters of data URL — the thing actually crossing `postMessage`, which is
 * a third larger than the file it came from.
 *
 * There is no downscaler to fall back on: one would be a runtime dependency and
 * this has none. So the ceiling is a real refusal rather than a quality knob,
 * and the chip that hits it offers an editor tab instead of a preview.
 */
const MAX_IMAGE_CHARS = 6 * 1024 * 1024;

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * A ref the CLI's transcript could never be holding: a file a turn merely
 * pointed at (`f|`), and one of our own the record owns (`r|`). Both are paths
 * or nothing, so falling through to the transcript for either tails up to 8 MB
 * to reach an answer already known.
 */
const owned = (id: string): boolean => id.startsWith('f|') || id.startsWith(REF_PREFIX);

/** A pid is not an identity once the process table has reused it. */
function sameIncarnation(panel: PanelActions, pid: number, startedAt: number): boolean {
  const current = ownedSession(pid)?.state ?? panel.sessions.find((session) => session.pid === pid);
  return current !== undefined && sameSessionStart(current.startedAt, startedAt);
}

/**
 * The bytes of a ref only the session's own CLI can still be holding, or
 * nothing for a brand with no such address (`CliAdapter.readImage`). The guard
 * is `owned`'s, above.
 */
async function inTranscript(session: Session, id: string): Promise<string | undefined> {
  if (owned(id)) {
    return undefined;
  }
  return adapterFor(session)?.readImage?.(session.transcript, id);
}

/**
 * An image ref that is also a file, read back as a data URL.
 *
 * The media type is the extension's, which is a rule both shapes already
 * passed: `writePastedImage` chose the name for one, and `core/transcript.ts`
 * refused to make a ref of the other until `mediaForExt` accepted it. Bytes
 * coming back out of a transcript are labelled by the transcript instead.
 */
async function onDisk(id: string): Promise<{ dataUrl?: string; tooLarge?: true } | undefined> {
  // Every scheme that names a file, and all of them are ours. `r|` is an image
  // the composer handed in, copied into a store of our own at the moment it
  // went on the wire — the CLI writes its own copy into the transcript as
  // base64 under an entry uuid the pipe never carries, so this is the only
  // address a record can hold for it.
  const file = refFile(id) ?? attachmentFile(id);
  if (!file) {
    return undefined;
  }
  const media = mediaForExt(path.extname(file));
  if (!media) {
    return undefined;
  }
  try {
    // Weighed before it is read, which `fetchImage`'s own ceiling cannot do —
    // it sees the data URL, and by then the file is already in this process.
    // Never mattered while every path here was one `writePastedImage` chose;
    // an `f|` path is one a model wrote down, and a turn can name any file on
    // the machine. Base64 is four characters per three bytes.
    const { size } = await fs.stat(file);
    if (size / 3 > MAX_IMAGE_CHARS / 4) {
      return { tooLarge: true };
    }
    return { dataUrl: `data:${media};base64,${(await fs.readFile(file)).toString('base64')}` };
  } catch {
    return undefined;
  }
}

/**
 * Answers one open request of a session this window drives — an ask's picks,
 * or a permission allowed once, allowed always, or denied.
 *
 * Nothing here composes the response: `OwnedSession.respond` builds it beside
 * the request it answers, which is where `answerPayload` turns picks into
 * labels and where a request the CLI has since retracted is dropped rather
 * than answered. There is no confirmation to wait for either — a response on
 * the pipe is a response received, which is the whole of the difference from
 * the keystroke path above.
 *
 * Every arm reports, and reports to the dialog rather than to the window. A
 * click on a dialog is a decision a person made, and the one ending it may
 * not have is silence: the panel's post is fire-and-forget, so a dialog that
 * froze on the click had nothing but the next state push to go by, which can
 * still be carrying the request this call just answered. `respondResult`
 * closes that: the control that was pressed stays frozen on `ok` until the
 * dialog goes, and comes straight back on a refusal.
 *
 * Which also puts the refusal where the decision was made. It used to be a
 * host warning, and a reader who has muted those — most of them — saw a
 * dialog quietly redraw itself instead.
 */
export async function respondRequest(
  panel: PanelActions,
  pid: number,
  startedAt: number,
  requestId: string,
  decision: RequestDecision
): Promise<void> {
  const report = (ok: boolean, reason?: string): void =>
    panel.post({
      type: 'respondResult',
      pid,
      startedAt,
      requestId,
      ok,
      ...(reason ? { reason } : {})
    });
  if (!sameIncarnation(panel, pid, startedAt)) {
    report(false, 'That session is no longer there to answer.');
    return;
  }
  const routed = routeTo(pid);
  if (isRefused(routed)) {
    // Dialog copy for every refused arm, Ended included — "gone" is this
    // sentence, not send's.
    report(false, 'That session is no longer there to answer.');
    void panel.refresh();
    return;
  }
  // The host's own re-check of what the ask layer already gated. A panel one
  // deploy behind can still post a decision at a session whose CLI has no
  // answer channel, and a click that vanishes is worse than one that says so.
  if (!routed.asks) {
    report(false, refusal('asks'));
    void panel.refresh();
    return;
  }
  const result = await routed.asks.respond(requestId, decision);
  report(result.ok, result.ok ? undefined : result.reason);
  void panel.refresh();
}

export async function buildThread(
  panel: PanelActions,
  sessions: Session[],
  // The poll's runnable half of `readWorkflowIndex()`, unawaited. Both this
  // and the panel's workflow list used to read the directory — twice per pass,
  // concurrently, at the 214/min `refresh` runs. Edits are not in this list.
  workflows: Promise<ReadWorkflow[]>,
  fullHistory = false
): Promise<BuiltThread> {
  const session = sessions.find((s) => s.pid === panel.selected);
  if (!session) {
    return {};
  }
  const owned = ownedSession(session.pid);
  const capture = owned && captureOwned(owned);
  const live = capture?.live;
  const recent = await renderTranscript(panel, session, capture?.shot);
  // Observe: label and steps off the session's own progress file, with the
  // stored definition preferred for the words. One `stat` on the selected
  // session's poll — nothing when the dock is empty, and no writes at all,
  // where this used to finish run records on child exit.
  //
  // **A dead child no longer ends the strip.** A card whose session has
  // exited keeps showing what its workflow reached, which is exactly when a
  // reader is most likely to look; `rollup` already tells running from done
  // from failed, so a finished pipeline reads as finished rather than as
  // absent. What ends a follow now is the reader dismissing the arming
  // message, a resume, or `prune.ts`'s 7-day sweep.
  //
  // A `/clear` needs no guard of its own: it mints a new session id
  // (`core/live.ts` prefers `init`'s over the held one), so the card moves to
  // a path that has no file. Resume is the mirror case, and is answered by
  // the unlink in `host/sessions.ts`.
  // `owned` only, exactly as the board pass is gated and for the same reason: a
  // session id outlives its process, so a workflow this panel started must not
  // paint a strip on a card the panel refuses to write to (`armMention`'s
  // refusal, `core/workflows/workflows.ts`'s `NO_PROTOCOL`).
  const progress =
    session.source === 'owned' && session.sessionId
      ? await readProgress(session.sessionId)
      : undefined;
  const workflow = progress
    ? followingWorkflow(
        progress,
        (await workflows).find((w) => w.id === progress.workflowId)
      )
    : undefined;
  const thread = composeThread(
    session,
    { history: { ...recent, historyState: capture?.historyState }, live },
    {
      // Only this caller holds the whole poll needed to find a parent.
      lineage: buildLineage(sessions).get(session.pid),
      skillsHere: await skills.skillsForSession(session),
      workflow,
      canModel:
        session.source === 'owned' && live?.exit === undefined && owned?.messages !== undefined,
      // Read reach from Session, where the launch line survives a fold.
      models: modelsForSession(
        session.brand,
        panel.models,
        session.launchReach,
        defaultsWide(
          sessionBrand(session.brand),
          session.modelPick,
          session.contextSize,
          session.launchReach
        )
      )
    }
  );
  thread.echoEvidence = recent.echoEvidence;
  thread.historyAvailable =
    !!recent.truncated && !!capture?.shot.conversation && !capture.shot.reconstructed;
  if (fullHistory && capture && thread.historyAvailable) {
    const page = await readRecordPage(capture.shot.conversation, 'full').catch(() => undefined);
    if (page) {
      const drawn = await transcriptAttribution.claimed(
        conversationKey(sessionBrand(session.brand), capture.shot.conversation),
        capture.shot.conversation,
        { exchanges: page.recorded.exchanges, truncated: false },
        page.recorded
      );
      const history = composeThread(
        session,
        {
          history: {
            exchanges: await Promise.all(
              drawn.exchanges.map(async (x) => (isMarker(x) ? x : exchangeView(x, render)))
            )
          },
          live
        },
        {}
      );
      thread.fullHistory = { exchanges: history.exchanges, folds: history.folds };
    }
  }
  return { thread, capture };
}

/** The dock's thread as one refresh composed it, and the reading of an owned
 *  session it was composed from. */
export type BuiltThread = { thread?: ThreadView; capture?: OwnedCapture };

/**
 * Render host-side because the markup engine is a host command. Cached results
 * spare the poll another render.
 * shot is buildThread's memory snapshot, requiring no file or CLI read.
 * Without one, read the session's files.
 */
export async function renderTranscript(
  panel: PanelActions,
  session: Session,
  shot?: ThreadSnapshot
): Promise<ThreadHalves['history']> {
  const sourced = shot
    ? await ownedTranscript(session.brand, shot)
    : await readSessionTranscript(session, configuredPathFor(session));
  const turns = {
    ...(await renderTurns(panel, sourced)),
    echoEvidence: echoCandidates.evidence(sourced.recent.exchanges)
  };
  if (!shot?.tail.length) {
    return turns;
  }
  return {
    ...turns,
    tail: await Promise.all(
      shot.tail.map(async (row) => ({
        position: Math.max(
          0,
          row.position - (sourced.recent.exchanges.length - turns.exchanges.length)
        ),
        // Do not cache streaming text: each poll would add a string with no later hit.
        exchange: await exchangeView(streaming.heldDraft(row.exchange), (text) =>
          render(text, false)
        )
      }))
    )
  };
}

async function renderTurns(
  panel: PanelActions,
  sourced: Sourced
): Promise<{ exchanges: ExchangeView[]; truncated: boolean; fallback?: true }> {
  const { recent } = sourced;
  // Carried beside the turns because it is a fact about the whole thread and
  // the reader is owed it: the fallback is a parse of a format nobody
  // contracted, and it is read as a tail.
  const fallback = reconstructed(sourced);
  // Identity here is an exact statement that the turns have not moved, bought
  // with no `stat` of our own: `core/transcript.ts` caches on `size:mtimeMs`
  // and returns the *same object* when the stamp has not moved, and a thread
  // snapshot keeps its `recent` across tail-only deltas. Everything below is a
  // pure function of it: `toolView` is pure, `render` is the host engine over
  // the same prose, and neither reads a clock. So the whole view can be handed
  // back rather than rebuilt.
  //
  // What that saves is not the parse — the parse was already cached — but the
  // ~148 KB of view this allocates around it on every poll, markdown render
  // per block included (`TASK_done_panel_repaint_cost.md`, Step 7).
  // Selecting another session misses, which is right: it is a different file.
  if (panel.renderedThread?.recent === recent) {
    return panel.renderedThread.view;
  }
  const from = recentUserFrom(recent.exchanges);
  const view = {
    exchanges: await Promise.all(
      recent.exchanges.slice(from).map(async (x) =>
        // A marker has no prose to render, and nothing to gain from passing
        // through the engine or its cache.
        isMarker(x) ? x : exchangeView(x, render)
      )
    ),
    truncated: recent.truncated || from > 0,
    fallback
  };
  panel.renderedThread = { recent, view };
  return view;
}

/** Rebuild protocol fields explicitly so raw tools and calls cannot cross the wire. */
async function exchangeView(
  x: Authored,
  engine: (text: string) => Promise<string>
): Promise<ExchangeView> {
  return {
    role: x.role,
    maintenance: x.maintenance,
    warmId: x.warmId,
    warmEvidence: x.warmEvidence,
    local: x.local,
    text: x.text,
    at: x.at,
    files: x.files,
    sizes: x.sizes,
    concurrent: x.concurrent,
    base: x.base,
    images: x.images,
    skill: x.skill,
    from: x.from,
    ...(x.cut ? { cut: true as const } : {}),
    blocks: await Promise.all(
      (x.blocks ?? (x.text ? [{ text: x.text }] : [])).map(async (block): Promise<BlockView> => {
        if ('call' in block) {
          return toolView(block.call);
        }
        return proseBlockView(x.role, Boolean(x.images), block, engine);
      })
    )
  };
}

/**
 * Puts a message on the session's pipe — this window's, or the window that
 * owns it. A session running in somebody's shell has no pipe, and is refused
 * rather than typed at.
 */
export async function sendMessage(
  panel: PanelActions,
  pid: number,
  startedAt: number,
  operationId: string,
  text: string,
  images?: ComposerImage[],
  workflowId?: string,
  target?: SendTarget
): Promise<void> {
  if (!sameIncarnation(panel, pid, startedAt)) {
    sendResult(
      panel,
      pid,
      false,
      'That session is no longer there to message.',
      undefined,
      operationId,
      startedAt
    );
    return;
  }
  // A mentioned workflow is checked where it will run before anything is
  // delivered, and the message that goes out is the enriched one: a line naming
  // the file, then whatever was typed (PRD §13/§14). A refusal delivers nothing
  // and writes nothing — it comes back as the composer's own blocked line, so
  // the draft is still there to fix.
  //
  // **The file does not exist yet**, and that is the whole of what keeps it
  // honest. Every path below this line can still refuse — a window that owns
  // the session has gone, a remote ask goes unanswered — and a file painted
  // ahead of them describes a step that was never composed. Its *content* has
  // to be written now, because the briefing names the path in this same
  // message; it is committed by whichever path actually takes the message.
  let body = text;
  // Stage before replacing the session's one progress file: a refused second
  // mention must not delete the existing workflow. Discard only the temp.
  let staged: StagedProgress | undefined;
  // What the session should be *called*, when that is not what it is sent.
  // Only a mention sets it: see `QueuedMessage.describe`.
  let describe: string | undefined;
  if (workflowId !== undefined) {
    // See armMention: the live snapshot includes a draft's pid before its first poll.
    const armed = await armMention(pid, workflowId, {
      board: panel.sessions,
      live: ownedSessions(vscode.env.sessionId)
    });
    if ('refused' in armed) {
      sendResult(panel, pid, false, armed.refused, undefined, operationId, startedAt);
      return;
    }
    body = enrich(armed.workflow, text);
    // Name the workflow and work, keeping its path and briefing out of the title.
    describe = text.trim() ? `${armed.workflow.label}: ${text.trim()}` : armed.workflow.label;
    // Staged before delivery so the briefing can name the path in this same
    // message. Failure is non-fatal: enrich still goes out on its own.
    staged = await stageForSend({
      sessionId: armed.sessionId,
      workflowId: armed.workflow.id,
      label: armed.workflow.label,
      steps: armed.workflow.steps
    });
    if (staged) {
      body = withProgressBriefing(
        body,
        staged.file,
        paths.toolShell(panel.sessions.find((session) => session.pid === pid)?.brand)
      );
    }
  }

  if (!sameIncarnation(panel, pid, startedAt)) {
    await staged?.discard();
    sendResult(
      panel,
      pid,
      false,
      'That session is no longer there to message.',
      undefined,
      operationId,
      startedAt
    );
    return;
  }

  // What a pipe takes, whichever window holds it: the images ride inline as
  // content blocks, so nothing is written to disk and no path appears in the
  // prose. Nothing to send is nothing to do.
  // Weighed on the enriched text, because that is what actually goes out: a
  // mention with an empty box is a message.
  const sent = delivery.deliveryText(body);
  const blocks = (images ?? []).map((image) => ({
    mediaType: image.mediaType,
    data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1)
  }));
  if (!sent && !blocks.length) {
    await staged?.discard();
    return;
  }

  const routed = routeTo(pid);
  if (isRefused(routed)) {
    await staged?.discard();
    sendResult(panel, pid, false, routed.sentence, undefined, operationId, startedAt);
    // No refresh: UNROUTED is the only routing refusal.
    return;
  }
  if (!routed.messages) {
    await staged?.discard();
    sendResult(panel, pid, false, refusal('messages'), undefined, operationId, startedAt);
    void panel.refresh();
    return;
  }
  if (blocks.length && !routed.messages.images) {
    await staged?.discard();
    sendResult(
      panel,
      pid,
      false,
      'That session cannot take attachments.',
      undefined,
      operationId,
      startedAt
    );
    void panel.refresh();
    return;
  }
  // Enqueue (and drain when idle). A busy/waiting session holds the message
  // in our outbox until drain — no mid-turn write, no status re-read. Remote
  // is the same message one window along: `ok` means the owning window took
  // it into its outbox, the same boundary.
  const result = await routed.messages.send(sent, blocks, describe, undefined, target);
  // Before `sendResult`, which posts to the webview and can throw on a
  // panel disposed during the ask — leaving a staged temp rather than an
  // uncommitted follow either way, but this keeps the two in one order on
  // both send paths.
  //
  // A reply that never came reads as the cautious answer: the message may
  // yet land, and a workflow that paints nothing is recoverable where one
  // that deleted a live file is not.
  if (result.ok) {
    await staged?.commit();
  } else {
    await staged?.discard();
  }
  sendResult(
    panel,
    pid,
    result.ok,
    result.ok ? undefined : result.reason,
    result.ok ? sent : undefined,
    operationId,
    startedAt
  );
  void panel.refresh();
}

/**
 * Ends the running turn, leaving the session alive at its prompt — the third
 * ending a turn can have from here, between waiting it out and stopping the
 * session outright.
 *
 * Capability and remote-unanswered refusals are still a host warning — H43
 * is the row that gives those a dock line of their own.
 */
export async function dismissQueued(
  panel: PanelActions,
  pid: number,
  startedAt: number,
  id: string
): Promise<void> {
  if (!sameIncarnation(panel, pid, startedAt)) return;
  const routed = routeTo(pid);
  if (isRefused(routed)) {
    refuseUnrouted(panel, pid, startedAt, routed.sentence);
    return;
  }
  if (!routed.messages) {
    vscode.window.showWarningMessage(refusal('messages'));
    return;
  }
  const result = await routed.messages.dismiss(id);
  if (!result.ok) {
    vscode.window.showWarningMessage(result.reason);
  } else if (result.queued !== undefined) {
    // An armed run only lives while its message is held. Empty outbox + still
    // armed means the arming message is gone — clear the strip. `undefined`
    // is a window built before this said anything, and reads as "cannot say"
    // rather than as nought (`core/coordination/requests.ts`) — coercing it would unlink
    // the file under an older window still holding the arming message.
    await cancelOrphanedArmed(panel, pid, result.queued);
  }
  void panel.refresh();
}

/**
 * Interrupt the running turn (if any) and send every held message as one.
 * Confirm is in the webview — this is the act after Confirm.
 */
export async function sendNow(panel: PanelActions, pid: number, startedAt: number): Promise<void> {
  if (!sameIncarnation(panel, pid, startedAt)) return;
  const routed = routeTo(pid);
  if (isRefused(routed)) {
    // Paint the refusal on #blocked like neighbouring verbs; do not refresh
    // for UNROUTED, the only routing refusal.
    refuseUnrouted(panel, pid, startedAt, routed.sentence);
    return;
  }
  if (!routed.messages) {
    vscode.window.showWarningMessage(refusal('messages'));
    return;
  }
  const result = await routed.messages.sendNow();
  if (!result.ok) {
    vscode.window.showWarningMessage(result.reason);
  }
  void panel.refresh();
}

export async function interruptSession(
  panel: PanelActions,
  pid: number,
  startedAt: number
): Promise<void> {
  if (!sameIncarnation(panel, pid, startedAt)) return;
  const routed = routeTo(pid);
  if (isRefused(routed)) {
    refuseUnrouted(panel, pid, startedAt, routed.sentence);
    return;
  }
  if (!routed.turn) {
    vscode.window.showWarningMessage(refusal('turn'));
    return;
  }
  // Idle or a refusal comes from the routed handle.
  const result = await routed.turn.interrupt();
  if (!result.ok) {
    vscode.window.showWarningMessage(result.reason);
  }
  void panel.refresh();
}

/**
 * Name a running session, from the dock's own head.
 *
 * Two cases since row 71, like every other session verb: a pipe this window
 * holds, or a session it cannot reach. `squadron-rename` is the other door
 * and posts a `rename` request, which the holding window serves.
 *
 * Nothing is posted back on success. The name is ours to state now — the owning
 * window writes it to `names/` and republishes at once — but it still reaches
 * this webview the way every other card fact does, on the next poll through
 * `foldTwins`. A surface that painted its own answer would be a second place
 * the rungs are ranked.
 */
export async function renameSession(
  panel: PanelActions,
  pid: number,
  startedAt: number,
  title: string
): Promise<void> {
  // stateName also serves squadron-rename. Both doors must refuse blanks
  // without assuming the other guard ran.
  if (!title.trim()) {
    return;
  }
  if (!sameIncarnation(panel, pid, startedAt)) return;
  const routed = routeTo(pid);
  if (isRefused(routed)) {
    refuseUnrouted(panel, pid, startedAt, routed.sentence);
    return;
  }
  if (!routed.naming) {
    // **The one case left**, and it is no longer about a brand. Every owned
    // card takes a rename — `routeTo` builds `naming` for a local pipe off
    // `stateName` and for a remote one unconditionally — so what is left here
    // is a route that offered neither, which nothing produces today. Kept as
    // the honest answer if one ever does, rather than deleted for a `!` that
    // would crash instead. `CANNOT.naming` says what is actually refused.
    vscode.window.setStatusBarMessage(refusal('naming'), STATUS_MS);
    return;
  }
  const result = await routed.naming.rename(title);
  if (!result.ok) {
    vscode.window.setStatusBarMessage(result.reason, STATUS_MS);
  }
  void panel.refresh();
}

/**
 * The warm list's switch for one session. The choice is the registry's to
 * write and publish (`sessions.setWarm`); the row learns it on the next push,
 * like every other card fact, and holds its own flip until then.
 */
export async function setWarmSession(
  panel: PanelActions,
  pid: number,
  startedAt: number,
  on: boolean
): Promise<void> {
  if (!sameIncarnation(panel, pid, startedAt)) {
    panel.post({ type: 'warmChoice', pid, startedAt });
    void panel.refresh();
    return;
  }
  const result = await setWarm(pid, on);
  panel.post({ type: 'warmChoice', pid, startedAt, ...(result.ok ? { on } : {}) });
  if (!result.ok) {
    vscode.window.setStatusBarMessage(result.reason, STATUS_MS);
  }
  void panel.refresh();
}

/**
 * The OS file dialog, opened for the composer's clip.
 *
 * The webview has no way to name a file on this machine, so the picking is
 * here and only the paths go back. Nothing is read and nothing is copied: the
 * session is told where the file is and reads it with its own tools, under
 * its own permission prompt — which is why this takes no size ceiling the way
 * a pasted image does, and why there is no capability to ask about: the path
 * is expanded into the prose and reaches the CLI as text, so a brand that
 * takes no inline image takes this.
 *
 * **It looks nothing up.** The box that asked is the only thing that knows
 * which box it is — a card or an unsent New — so it sends its own folder and
 * gets the id back. What that folder must be is measured: the dialog opens
 * where the session is *standing*, not where the conversation began.
 * `Session.cwd` is the origin (the group); `liveCwd` is the CLI's current
 * directory, and rides `CardView` for this. On macOS they diverge for a
 * session started under `/var/folders` — spawn records the symlink, `init`
 * states `/private/var/folders` — and `showOpenDialog` returns `fsPath` in the
 * spelling it was opened on. Opening on the origin made the echo `/var/…`
 * while smoke waits on `realpath` (`/private/var/…`).
 */
export async function pickFiles(
  panel: PanelActions,
  cwd: string,
  operationId: string
): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Attach',
    defaultUri: vscode.Uri.file(cwd)
  });
  // Answer cancels too: an unsettled operation id holds its draft forever,
  // leaving New marked as drafting over an empty box.
  panel.post({ type: 'pickedFiles', operationId, paths: picked?.map((uri) => uri.fsPath) ?? [] });
}

/**
 * The bytes behind a ref a reader just opened.
 *
 * Disk first and the transcript second, because the two hold the same image
 * for different lengths of time: our own pastes are swept after a day, while
 * the transcript keeps what the CLI read for as long as the file itself
 * lives. A ref that resolves to neither says so, so the chip can explain
 * itself instead of rendering a broken picture.
 */
export async function fetchImage(panel: PanelActions, pid: number, id: string): Promise<void> {
  const session = panel.sessions.find((s) => s.pid === pid);
  if (!session) {
    return;
  }
  const post = (m: ImageDataMessage): void => void panel.panel.webview.postMessage(m);
  const disk = await onDisk(id);
  if (disk?.tooLarge) {
    post({ type: 'imageData', id, reason: 'tooLarge' });
    return;
  }
  const dataUrl = disk?.dataUrl ?? (await inTranscript(session, id));
  if (!dataUrl) {
    post({ type: 'imageData', id, reason: 'gone' });
  } else if (dataUrl.length > MAX_IMAGE_CHARS) {
    // See MAX_IMAGE_CHARS for why the editor replaces an oversized preview.
    post({ type: 'imageData', id, reason: 'tooLarge' });
  } else {
    post({ type: 'imageData', id, dataUrl });
  }
}

/**
 * The image in an editor tab, where a reader can save, copy or diff it, and the
 * only thing left to offer for one too big to inline.
 *
 * A ref that never had a file gets one written now: `writePastedImage` takes
 * exactly the data URL the transcript hands back, so the image pasted into a
 * terminal opens the same way as the image that arrived as a path.
 */
export async function openImage(panel: PanelActions, pid: number, id: string): Promise<void> {
  const session = panel.sessions.find((s) => s.pid === pid);
  if (!session) {
    return;
  }
  let file = refFile(id) ?? attachmentFile(id);
  if (!file || !(await exists(file))) {
    // The common case here is a ref that names a file and no longer has one —
    // an agent's `/tmp` render, swept since — and it ends at the warning below
    // either way.
    const dataUrl = await inTranscript(session, id);
    const media = dataUrl?.slice(5, dataUrl.indexOf(';'));
    file = dataUrl && media ? await writePastedImage({ mediaType: media, dataUrl }) : undefined;
  }
  if (file) {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
  } else {
    void vscode.window.showWarningMessage('That image is no longer on disk.');
  }
}

/**
 * Unrouted send, interrupt, rename and dismiss — not sendNow.
 *
 * A toast (`showWarningMessage`) is invisible when host notifications are
 * muted, which they are on this machine. Rename used the status bar, and
 * that is IDE chrome a reader looking at the panel does not watch. `send`
 * already posts `sendResult`, and the dock paints the reason on `#blocked`.
 */
function refuseUnrouted(
  panel: PanelActions,
  pid: number,
  startedAt: number,
  sentence: string
): void {
  sendResult(panel, pid, false, sentence, undefined, undefined, startedAt);
}

/**
 * Report delivered text so the dock can match its echo to the recorded turn.
 * Workflow enrichment happens here; the webview's original subject is only a
 * suffix of the delivered turn and cannot match it.
 */
export function sendResult(
  panel: PanelActions,
  pid: number,
  ok: boolean,
  reason?: string,
  text?: string,
  operationId?: string,
  startedAt?: number
): void {
  panel.post({ type: 'sendResult', pid, ok, reason, text, operationId, startedAt });
}
