/**
 * Chat owner transitions. Board navigation never changes the active chat.
 */

import { dock, chats, ui, vscode } from './state';
import { $ } from './dom';
import { closeMenu } from './kit';
import { closeRename, landed, renderActive, standBy } from './chat';
import { sameSessionStart } from '../core/model';
import {
  focusBox,
  lockBox,
  ownerKey,
  rekeyBox,
  releaseBox,
  renderMention,
  sendHeld,
  setBox,
  stashBox
} from './composer';
import { repaintBoard } from './board_repaint';
import { clearReplay, renderQuestion } from './question';
import { closeMentionMenu } from './mentions';
import { setOpen } from './workflow_overview_drawer';

function leaveOwner(): void {
  stashBox();
  clearReplay();
  // A held pill/menu vetoes its own repaint. Close it before destination
  // controls render, including host-driven reveals with no pointer blur.
  closeMenu();
  closeMentionMenu();
  closeRename();
  setOpen(false);
  renderQuestion(undefined);
}

export function select(pid: number, startedAt?: number, redraw = false): void {
  const current = chats.active();
  if (
    current?.kind === 'session' &&
    current.pid === pid &&
    (startedAt === undefined || sameSessionStart(current.startedAt, startedAt)) &&
    !redraw
  ) {
    stashBox();
    closeMenu();
    return;
  }
  const destination = chats.session(pid)?.identity;
  if (
    startedAt !== undefined &&
    destination &&
    !sameSessionStart(destination.startedAt, startedAt) &&
    startedAt < destination.startedAt
  )
    return;
  // A draft the dock is leaving keeps what is in its box, the same way a
  // session's does. Stashed before the leave, because the leave reads it: a
  // draft nobody wrote in is dropped rather than left (`closeDraft`).
  leaveOwner();
  if (chats.activateSession(pid, startedAt) === undefined) return;
  if (!chats.session(pid)) return;
  // And the layer, which `clearReplay` above only reaches when a record is open.
  // The leave a reader makes most was the one that left the last session's
  // dialog standing over the new one's board — offering an answer for a session
  // the dock has just left, until the push answering the select lands a poll
  // later. Every owner transition clears it before rendering the destination.
  // The box carries `canSend` from the session that was open, and `renderThread`
  // does not restate it until the push answering the select below — up to a poll
  // away. Left alone, picking a live session off a blocked one hands the reader
  // a composer they cannot type into for no reason they can see. Cleared rather
  // than guessed: unknown is what a drop's own send already rides on.
  lockBox(false, 'Message this session…');
  setBox();
  renderMention();
  standBy(pid);
  vscode.postMessage({ type: 'select', pid, selection: chats.requestSelection() });
  // Last, and the only repaint on this path: it is what moves the mark to the
  // card just clicked.
  repaintBoard();
}

/**
 * Press New: show this folder's draft, making one if it has none.
 *
 * **The press no longer spawns.** What a session starts on — brand, model,
 * window — is part of the act now rather than read from three machine-global
 * settings on receipt, and it is decided on the draft's own surface. An
 * abandoned New therefore costs nothing at all.
 *
 * Idempotent, because `openDraft` is: a second New on a folder that already has
 * a draft brings it back up with everything still in it and discards nothing
 * that was typed. On an empty one it re-mints, which is that same draft by
 * everything a reader can see.
 *
 * It runs `select`'s own sequence, because leaving a session is the same act
 * whichever way you leave it: stash what was in its box, drop a replayed
 * question that belongs to it, shut a skill menu filtered against its skills,
 * and tell the host nothing is selected. That last one needs no message of its
 * own — a `select` with pid 0 is what a close already posts, and `panel.ts`
 * maps it to no selection.
 */
export function showDraft(cwd: string | undefined): void {
  if (cwd === undefined) return;
  // The guard, not the class: `pointer-events` is styling, and one spawn per
  // group in flight is the invariant. It applies to opening the surface as well
  // as to the send — a draft opened while its own predecessor is still coming
  // up would take a second prompt this slot cannot carry.
  if (chats.openInFlight(cwd) && !chats.draftFor(cwd)) return;
  const current = chats.active();
  if (current?.kind === 'draft' && current.cwd === cwd) {
    return;
  }
  const left = ui.selected;
  leaveOwner();
  // And the live dialog with it — the launcher is the composer's, and a draft's
  // composer writes to no session at all. `select` gets this from the push
  // answering it; a draft is never anybody's thread, so no state push reaches
  // `renderThread` while one is up (`main.ts`) and the layer would keep the
  // question the *last* session was blocked on, over a box that cannot answer
  // it. After `clearReplay`, which is what a record would otherwise be redrawn
  // from here.
  // The record only — what goes in the box is `renderDraft`'s, through `setBox`.
  chats.openDraft(cwd);
  lockBox(false);
  renderActive();
  renderMention();
  // Only when something was actually deselected: a second New while a draft is
  // already up would otherwise post a deselect the host has already been told.
  if (left) vscode.postMessage({ type: 'select', pid: 0, selection: chats.requestSelection() });
  repaintBoard();
}

/**
 * Bind the unbound chat onto the session the reveal named, then send the held
 * snapshot through ordinary `send`. Selection follows only when this chat is
 * the one the dock is on.
 */
export function promoteDraft(id: string, pid: number, startedAt: number): void {
  const cwd = chats.draftById(id)?.cwd;
  const bound = chats.bindSession(id, pid, startedAt);
  if (!bound) return;
  // The same box taking its session's key: what is in it, its Undo history
  // and its pool stay. Only a change to another box starts a fresh history.
  if (cwd !== undefined) rekeyBox(ownerKey({ kind: 'draft', cwd }), ownerKey(bound.owner));
  if (bound.active) {
    // Before the select, whose stand-in keeps the seat for this pid alone.
    landed(pid);
    select(pid, startedAt, true);
  } else {
    // The host selected the new pid when it revealed it (`revealSession`), and
    // the reader is elsewhere: say where — another card, or nothing (pid 0) —
    // or the host's pushes follow the new session and a card on screen waits
    // on Loading… for a thread that never comes.
    vscode.postMessage({
      type: 'select',
      pid: ui.selected ?? 0,
      selection: chats.requestSelection()
    });
  }
  if (bound.snapshot) sendHeld(pid, bound.snapshot);
  repaintBoard();
}

function putAwayChat(): void {
  leaveOwner();
  // `renderThread(undefined)` has no pid for the mismatch rule to compare
  // against, so leaving the session is said here.
  chats.deactivate();
  // Leaving prunes the record's pool to what its document names, so the
  // history that could Undo a deleted chip back must not survive the return.
  releaseBox();
  // Nor is a first reply arriving in front of anyone now.
  landed();
  renderQuestion(undefined);
  renderActive();
}

function closeChat(): void {
  const cwd = ui.state.defaultCwd;
  if (cwd !== undefined) {
    showDraft(cwd);
  } else {
    putAwayChat();
    vscode.postMessage({ type: 'select', pid: 0, selection: chats.requestSelection() });
    repaintBoard();
  }
  focusBox();
}

$('chat-dismiss').onclick = closeChat;

export function closeEnded(sessions: readonly { pid: number; startedAt: number }[]): void {
  const active = chats.active();
  if (
    active?.kind !== 'session' ||
    !sessions.some(
      (session) => session.pid === active.pid && session.startedAt === active.startedAt
    )
  )
    return;
  putAwayChat();
  showDraft(ui.state.defaultCwd);
}

const seenUpdates = new Map<number, number>();

function acknowledge(): void {
  const card = ui.state.groups
    .flatMap((group) => group.sessions)
    .find((session) => session.pid === ui.selected);
  if (!card || (!card.unread && !card.attention) || seenUpdates.get(card.pid) === card.updatedAt)
    return;
  seenUpdates.set(card.pid, card.updatedAt);
  vscode.postMessage({ type: 'seen', pid: card.pid });
}

for (const type of ['pointerdown', 'keydown', 'wheel'])
  dock.addEventListener(type, acknowledge, { capture: true, passive: true });
