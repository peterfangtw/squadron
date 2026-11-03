import * as ticketDetails from './ticket_details';
/**
 * The panel's browser half's entry point: `esbuild.mjs` bundles this module's
 * import graph into the single bare IIFE that `document.ts` inlines into the
 * webview's HTML — the panel's CSP admits scripts by nonce only, so the output
 * must run as a plain script. Shared types come from `protocol.d.ts`, which
 * stays ambient so the host half can check against it too.
 *
 * This file holds what runs at load: the divider and the message wiring.
 */

import { $ } from './dom';
import { acceptEnds, applyState, cards, chats, dock, saved, ui, vscode } from './state';
import * as holds from './holds';
import { onCompositionEnd, onCompositionStart, onMenuBlur, onMenuKey } from './kit';
import { mountTips, refreshTip } from './tip';
import { playCue } from './sound';
import { record } from './perf';
import { setOnScreen, visible, watchVisibility } from './visibility';
import { measureColumns, refuseTheme, renderBoard, settleTheme, tickStamps } from './board';
import * as bottomHub from './bottom_hub';
import * as bottomDrawer from './bottom_drawer';
import { syncMascot } from './mascot';
import { closeEnded, promoteDraft, select, showDraft } from './dock';
import { repaintBoard, setDraftRepaint } from './board_repaint';
import { dockDrag, renderActive, takeImage, tickHead } from './chat';

import { relabelBox, renderMention, setBox, syncComposer, takePickedFiles } from './composer';
import { editing, takeDeleteResult, takeSaveResult } from './editor';
import { settleSent } from './question';
import { takeConversations, takeResumeResult, takeResumeStartup } from './resume';
import { repaintRunPicker, takePorts } from './runpicker';
import { renderTickets, settleFilter, fenceTicketState } from './tickets';
import { takeLoginProgress, takeSignOutResult } from './accounts';
import { forget } from './board_card';
import { repaintMcpFooter, repaintMcpSheet, takeMcpActionProgress } from './mcp_sheet';
import { settleFigure, settleWarm } from './warm_menu';
import { allowlistFailed } from './remote_setup';
import { settleRemote } from './remote_sheet';
import { onLightboxKey } from './lightbox';
import { renderOnboarding } from './onboarding';
import * as settings from './settings';
import { confirmModal } from './confirm_modal';
// The composer and the dialog boxes mount the prose input; imported here as well
// for its test seam (`squadronProse`), which `prose.test.ts` mounts editors through.
import './prose';

let defaultDraftInitialized = false;

// ---- resizable divider -----------------------------------------------------

// Half the panel is the dock's ceiling — past it the board is the narrower
// column, and the cards, not the chat, are what the panel is for. The floor
// stays a fixed 280px, since a dock thinner than that reads nothing.
// The ceiling is stated twice on purpose: here, so a drag cannot run the
// divider off the pointer, and in #dock's max-width, so a window that narrows
// after the drag is clamped by the browser rather than by a resize listener.
// A drag applies a width every frame and is read back only once, when it ends:
// `dockPx` is what the box is wearing, so the end has something to hand over.
let dragging = false;
let dockPx = 0;

const setWidth = (px: number): void => {
  dockPx = Math.max(280, Math.min(px, Math.round(window.innerWidth * 0.5)));
  dock.style.width = dockPx + 'px';
  // The box wears the width synchronously; only the memory of it waits. Told to
  // the host per frame it is a round-trip per frame for a value the drag is
  // about to replace.
  if (!dragging) vscode.setState({ dockWidth: dockPx });
};
setWidth(saved.dockWidth ?? Math.round(window.innerWidth * 0.36));

$('divider').addEventListener('mousedown', (e) => {
  e.preventDefault();
  $('divider').classList.add('dragging');
  dragging = true;
  // What the thread does with this, and what it costs unsaid: `dockDrag`.
  dockDrag(true);
  const move = (ev: MouseEvent) => setWidth(window.innerWidth - ev.clientX);
  const up = () => {
    dragging = false;
    dockDrag(false);
    vscode.setState({ dockWidth: dockPx });
    $('divider').classList.remove('dragging');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// ---- the board's width -----------------------------------------------------

// A family box is capped at the board's column count, which changes only when
// the board changes width. Observed rather than polled, so the 1s repaint stays
// free of layout reads, and guarded because jsdom has no ResizeObserver — there
// the floor stands and the board draws as it does on the narrowest real window.
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureColumns).observe(cards);

// ---- menus -----------------------------------------------------------------

// The pill-and-menu control is built in `kit.ts`; the two listeners that let an
// open menu be walked with the arrows or dismissed by a click elsewhere are
// load-time work, so they are registered here with the rest of it.
document.addEventListener('keydown', onMenuKey);
document.addEventListener('mousedown', onMenuBlur);
// Capture so one Escape belongs to the top surface alone; ask targets keep the
// ask layer's own handler, while the lightbox stops the listeners under it.
document.addEventListener('keydown', onLightboxKey, true);

// ---- input methods ---------------------------------------------------------

// What lets `paintIfChanged` hold a repaint off a box being composed in — why,
// on the guard itself in `kit.ts`. Delegated at the document because composition
// events bubble, so no box added later has to opt in.
document.addEventListener('compositionstart', onCompositionStart);
document.addEventListener('compositionend', onCompositionEnd);

// ---- hover tips ------------------------------------------------------------

// The panel's own explanations, in place of the host's `title=`. Delegated at
// the document, so the bars that morph every second need know nothing about it.
mountTips();

// ---- wiring ----------------------------------------------------------------

/**
 * Forget what a session that no longer exists was holding: its draft, its pasted
 * images, its mentioned workflow, a refusal aimed at it, and the name the
 * scramble last painted. All of those are keyed by pid alone, and the process
 * table recycles those — left standing, a dead session hands whatever it had to
 * whatever starts next under the same number.
 *
 * **Swept on identity, never on absence**, and that distinction is the whole of
 * this function. A card missing from a push is not evidence of death: `discover`
 * answers an empty list to a failed `readdir`, and `scanProcesses` to a failed
 * `ps` — which `scan.ts` refuses to cache for precisely this reason, since one
 * bad poll would otherwise blank the board. A board that blanks repaints; a
 * sweep that read absence as death would eat what somebody is typing, and the
 * next push would not bring it back.
 *
 * A pid reporting a **different** start is evidence, and it is exactly the flaw:
 * a new session under a recycled number. `arrange.ts` guards its slots the same
 * way and says so in the same words. The cost is an entry per pid the board has
 * ever shown, which is a number in a map for the life of one webview.
 */
function sweepRecycled(replaced: readonly import('../ui/chat_state').SessionIdentity[]): void {
  for (const { pid } of replaced) forget(pid);
}

function syncVisibility(): void {
  document.body.classList.toggle('warm-paused', !visible());
}

syncVisibility();
watchVisibility(syncVisibility);

// The draft surface's own repaint hook, for `board_nav.ts`'s pending timeout —
// the one change to a draft that no event on the draft causes. Wired here for
// `setBoardRepaint`'s reason: the module that needs it may not import `chat.ts`.
setDraftRepaint(renderActive);

window.addEventListener('message', (e: MessageEvent<PanelMessage>) => {
  const msg = e.data;
  if (msg.type === 'ticketDetail') {
    ticketDetails.takeTicketDetail(msg);
    return;
  }
  if (msg.type === 'confirmModal') {
    ticketDetails.closeTicketDetail();
    confirmModal(msg, (actionId) =>
      vscode.postMessage({
        type: 'confirmModalResult',
        requestId: msg.requestId,
        ...(actionId === undefined ? {} : { actionId })
      })
    );
    return;
  }
  if (msg.type === 'resumeResult') {
    takeResumeResult(msg);
    return;
  }
  if (msg.type === 'warmChoice') {
    settleWarm(msg);
    return;
  }
  if (msg.type === 'remoteChoice') {
    settleRemote(msg);
    return;
  }
  if (msg.type === 'flagChoice') {
    holds.settleFlag(msg);
    bottomDrawer.repaintModes();
    return;
  }
  if (msg.type === 'themeChoice') {
    if (!msg.landed) refuseTheme(msg.theme);
    return;
  }
  if (msg.type === 'warmSettingChoice') {
    settleFigure(msg);
    return;
  }
  if (msg.type === 'remoteAllowlistFailed') {
    allowlistFailed(msg.reason, msg.account);
    bottomDrawer.repaintMode('remote');
    return;
  }
  if (msg.type === 'visible') {
    // The host clears `lastState` and pushes on the same
    // event, so becoming visible repaints through the ordinary door a moment
    // later. This gates the beat and CSS motion in between.
    setOnScreen(msg.visible);
    return;
  }
  if (msg.type === 'reveal') {
    // A reveal naming a draft is that draft becoming this card, and it is the
    // one reveal that does more than select: everything the reader wrote goes
    // onto the pid and the first turn is posted for it.
    //
    // Every other reveal keeps today's path. A resume, a `squadron-spawn`
    // and another window's start all arrive here with no draft id, and none of
    // them has a surface waiting to be promoted.
    if (msg.draftId !== undefined) {
      promoteDraft(msg.draftId, msg.pid, msg.startedAt);
    } else {
      select(msg.pid, msg.startedAt);
    }
    return;
  }
  if (msg.type === 'startupStatus') {
    takeResumeStartup(msg);
    if (msg.state === 'started' && msg.pid !== undefined && msg.startedAt !== undefined)
      promoteDraft(msg.attemptId, msg.pid, msg.startedAt);
    else if (msg.state === 'stopped')
      chats.failDraftStart(msg.attemptId, msg.reason ?? 'Session start stopped.');
    else
      chats.noteStartup(
        msg.attemptId,
        msg.state === 'waiting'
          ? 'Starting session…'
          : (msg.reason ?? 'Start outcome unknown. Your message is held.')
      );
    renderActive();
    repaintBoard();
    return;
  }
  if (msg.type === 'openResult') {
    if (!msg.ok) {
      if (msg.unsure || !msg.notStarted)
        chats.noteStartup(
          msg.draftId,
          msg.reason ?? 'Start outcome unknown. Your message is held.'
        );
      else chats.failDraftStart(msg.draftId, msg.reason ?? 'That session did not start.');
      // Only while a draft is what the dock is showing. A refusal can land
      // after the reader went to look at another card, and `renderDraft` with
      // no draft falls through to the vacant plate — which would replace that
      // session's whole thread with "No session selected" while its head and
      // composer stayed. It self-corrects on the next push; a reader watching
      // it does not know that.
      renderActive();
      repaintBoard();
    }
    return;
  }
  if (msg.type === 'sound') {
    // Nothing drawn, nothing selected: a cue is about a session the reader may
    // not be looking at, which is the whole point of it.
    playCue(msg.cue, ui.state.soundLevel);
    return;
  }
  if (msg.type === 'imageData') {
    takeImage(msg);
    return;
  }
  if (msg.type === 'conversations') {
    takeConversations(msg);
    return;
  }
  if (msg.type === 'ports') {
    takePorts(msg);
    return;
  }
  if (msg.type === 'pickedFiles') {
    takePickedFiles(msg);
    return;
  }
  if (msg.type === 'saveWorkflowResult') {
    takeSaveResult(msg);
    return;
  }
  if (msg.type === 'deleteWorkflowResult') {
    takeDeleteResult(msg);
    return;
  }
  if (msg.type === 'loginProgress') {
    takeLoginProgress(msg);
    settings.render();
    return;
  }
  if (msg.type === 'signOutResult') {
    takeSignOutResult(msg);
    settings.render();
    return;
  }
  if (msg.type === 'respondResult') {
    // The one thing a dialog could not know: whether the answer it froze itself
    // for actually went. Per request, not per push — see `sending` in
    // `question.ts` for why a push is the wrong evidence.
    settleSent(msg.pid, msg.startedAt, msg.requestId, msg.ok, msg.reason);
    return;
  }
  if (msg.type === 'sendResult') {
    // Accepted, and the host says what it actually delivered — which is not
    // what was typed when the send carried a mention: the workflow line is
    // composed host-side and the subject sits *beneath* it. The echo settles by
    // matching the turn the CLI writes down, so it has to hold the delivered
    // text or it matches a suffix of that turn and never settles at all: the
    // dock would keep a ghost `you` bubble (an empty one, for a mention sent
    // with an empty box) for as long as the session stays busy.
    const result = chats.settleSend(
      msg.pid,
      msg.startedAt,
      msg.operationId,
      msg.ok,
      msg.reason,
      msg.text
    );
    if (!result.owner || ui.selected !== result.owner.pid) return;
    // A refused send restored into the box comes back with a fresh history.
    if (result.restored) setBox();
    else syncComposer();
    renderMention();
    renderActive();
    return;
  }
  if (msg.type === 'closeResult') {
    acceptEnds(msg.sessions);
    closeEnded(msg.sessions);
    renderBoard();
    return;
  }
  // Nothing here decides about motion. `renderBoard` below compares this push's
  // slot order against the one on screen, which is the same comparison this
  // block used to make a line early — it skips a transition captured against
  // the board being replaced, and starts its own where the push moves a card.
  // Counted here rather than at the top of the handler: this is the state push,
  // and it is the one message that repaints both surfaces. Every branch above
  // returned. See `perf.ts` — `paint` has two drivers and is unreadable without
  // this one counted apart from the beat.
  if (msg.type === 'mcpActionProgress') {
    takeMcpActionProgress(msg);
    return;
  }
  if (msg.type === 'thread' || msg.type === 'threadPatch') {
    if (!chats.takeThread(msg)) {
      const recovery = chats.threadRecovery();
      if (recovery) vscode.postMessage(recovery);
      return;
    }
    record('threadPush');
    renderMention();
    renderActive();
    refreshTip();
    return;
  }
  record('push');
  fenceTicketState(msg);
  ticketDetails.syncTicketDetail(msg.ticketSource);
  const replaced = applyState(msg);
  // Before any surface repaints, and whichever sheet is up: a flip that a
  // push agrees with while its surface is shut is still the write landing.
  holds.settle();
  sweepRecycled(replaced);
  if (!defaultDraftInitialized && (chats.active() || ui.state.defaultCwd !== undefined)) {
    defaultDraftInitialized = true;
    if (!chats.active()) showDraft(ui.state.defaultCwd);
  }
  const active = chats.active();
  const replacement =
    active?.kind === 'session' ? replaced.find(({ pid }) => pid === active.pid) : undefined;
  if (replacement) select(replacement.pid, replacement.startedAt, true);
  settleFilter();
  settleTheme();
  // Before the board: the accounts popover fills once, on open, and `renderNav`
  // will not touch a bar held open by its own menu — so an MCP login's progress
  // has no other way onto the screen. The footer and the sheet both live off
  // this push; the sheet is the surface that moves.
  repaintMcpFooter();
  repaintMcpSheet();
  renderBoard();
  // After the board, so the sheet reads the stop marks its chips just settled.
  repaintRunPicker();
  bottomHub.render();
  // Beside the bar it rose out of: the list it draws is the same array, and a
  // workflow that has gone must leave the sheet on the same push it leaves the
  // chips.
  bottomDrawer.render('push');
  // After the bar and the sheet it perches on, so it measures them as drawn.
  syncMascot(msg);
  // No café cup: dismounted 2026-10-05 for its animation cost (`cafe.test.ts`).
  // `msg.awake` still arrives for whatever shows the hold next.
  renderOnboarding();
  settings.render();
  // Beside the bar, and for its reason: no state push repaints the composer
  // except `renderThread`, and a chip has to go when its workflow does.
  renderMention();
  // A session chip in the box names its card, and this push may rename it.
  relabelBox();
  if (ui.boardView === 'tickets' && !editing()) renderTickets();
  if (ui.selected || !chats.active()) renderActive();
  // After the paint, not before: an open tip reads its words back off the
  // anchor this push has just rewritten.
  refreshTip();
});

// Both stamps on one beat: the board's cards and the dock's head read the same
// `updatedAt` through the same `since`, so anything slower for one of them puts
// two different answers to "how long ago" on screen at once.
setInterval(() => {
  // Nothing on this beat is worth drawing into a document nobody is looking at:
  // every one of them advances a clock, and a clock read on the way back in is
  // as current as one kept warm. The host slows its own poll on the same event
  // (`pace`, `panel.ts`) and pushes on becoming visible, which repaints all of
  // this anyway.
  if (!visible()) {
    return;
  }
  record('tick');
  // `tickStamps`, not `renderBoard`: the only thing on a card that moves on a
  // clock is its stamp, and rebuilding the whole card tree to advance it was 60
  // of the board's 64 paints a minute. See `tickStamps` for why this one span is
  // safe to lift out from behind the reconciler, and nothing else is.
  tickStamps();
  tickHead();
  refreshTip();
}, 1000);

renderBoard();
bottomHub.render();
bottomDrawer.render();
renderActive();

// Last line of the entry, and after the listener above is wired: the host answers
// this with a full state, and one that arrived before the handler existed would
// be dropped. Says only "this document is new" — see `ready` in `protocol.d.ts`
// for what the host does about it, and why a fresh document cannot be left to
// the poll.
vscode.postMessage({ type: 'ready' });
