import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { conversationKey } from '../core/adapter';
import { sessionBrand } from '../core/brands';
import * as pages from '../core/conversation_pages';
import type { Conversation } from '../core/conversations';
import type { LaunchTarget } from '../core/model';
import { liveRecords, readPublished } from '../core/published';
import { scanProcesses } from '../core/scan';
import { refFor } from '../core/session_ref';
import {
  cancelStartup,
  aliasStartup,
  reconcileStart,
  startupStatus,
  dropSession,
  sessionExited,
  startOwned,
  type StartResult
} from './sessions';
import { checkoutLabel } from '../ui/text';
import { PanelActions } from './panel_actions';
import { STATUS_MS } from './session_io';

const pendingResumes = new Map<string, { id: string; result: Promise<StartResult> }>();

/** Select a session and put the reader in front of it. */
export function revealSession(
  panel: PanelActions,
  pid: number,
  startedAt: number,
  draftId?: string
): void {
  panel.selected = pid;
  panel.selectedStartedAt = startedAt;
  panel.panel.reveal();
  panel.post({
    type: 'reveal',
    pid,
    startedAt,
    ...(draftId !== undefined ? { draftId } : {})
  });
  void panel.refresh();
}

/**
 * Starts a session in a group's directory, always in this window.
 *
 * A start this reader made selects what it started, because the board's order
 * decides where the new card lands and the reader would otherwise hunt for it.
 * `serve()`'s `open` request, from another window or the `squadron-spawn` CLI,
 * never reaches here (`extension.ts` calls `startOwned` itself), so a
 * background agent spawning a peer cannot pull a reader's window onto this tab.
 */
export async function openSession(
  panel: PanelActions,
  ask: {
    cwd: string;
    /**
     * What the start runs on, stated rather than read from a setting, and
     * whole rather than field by field. A stated model goes through
     * `checkSpawnIdentity`, which refuses a brand mismatch. Empty or absent
     * `model` is the account's own default (`startOwned` folds both the same
     * way), and absent `effort` sends no override.
     */
    target?: LaunchTarget;
    /** A draft's first line, cut like a spawn's prompt, so a draft's card is
     *  labelled like a spawn's and gives way to the CLI's own title as readily.
     *  Never `--name`: see `core/naming.ts`. */
    placeholder?: string;
    /** The surface waiting for this start, carried back on the reveal. */
    draftId?: string;
  }
): Promise<void> {
  const { cwd, draftId } = ask;
  if (!cwd) {
    return;
  }

  const started = await startOwned({
    attemptId: draftId,
    cwd,
    ...(ask.target === undefined ? {} : { target: ask.target }),
    placeholder: ask.placeholder
  }).catch((error: unknown): StartResult => ({
    ok: false,
    unsure: true,
    reason: error instanceof Error ? error.message : 'The session start could not be confirmed.'
  }));
  if (!started.ok) {
    // A draft has a surface of its own to say this on, and host notifications
    // are muted here. Every reason `startOwned` gives before a child exists
    // comes back this way: a missing binary, a failed preflight, a brand and
    // model that do not go together.
    if (draftId !== undefined) {
      panel.post({
        type: 'openResult',
        draftId,
        ok: false,
        reason: started.reason,
        ...(started.notStarted ? { notStarted: true } : {}),
        ...(started.unsure ? { unsure: true } : {})
      });
      return;
    }
    vscode.window.showWarningMessage(started.reason);
    return;
  }
  // `startOwned` already announced the card, so the nudge is only for what
  // discovery adds around it. The reveal refreshes at once rather than waiting
  // on the first nudge. For a draft it carries the id of the surface that is
  // waiting to become this card.
  if (!panel.disposed) revealSession(panel, started.pid, started.startedAt, draftId);
  nudgeDiscovery(panel);
}

export async function reconcileStartup(
  panel: PanelActions,
  id: string,
  cancel: boolean
): Promise<void> {
  if (cancel) await cancelStartup(id);
  else await reconcileStart(id);
  const status = startupStatus(id);
  const result = status.result;
  panel.post({
    type: 'startupStatus',
    attemptId: id,
    state: status.pending
      ? 'waiting'
      : !result || (!result.ok && result.unsure)
        ? 'unknown'
        : result.ok
          ? 'started'
          : 'stopped',
    stage: status.stage,
    ...(result?.ok
      ? { pid: result.pid, startedAt: result.startedAt }
      : {
          reason:
            result?.reason ?? 'The start could not be confirmed. Keep this text and check again.'
        })
  });
}

/**
 * Whether a card on the board is a corpse: a session this window started whose
 * child has exited. The same reading `toThread` takes for the dock's ended line
 * (see `exited` there), so a conversation the dock calls over cannot be one the
 * picker calls live.
 *
 * This window's own state and no record: a card on this board is one this
 * window started or a background session, and neither is read out of a
 * published half.
 */
export function sessionEnded(pid: number): boolean {
  return sessionExited(pid);
}

/**
 * Every conversation running anywhere on this machine, as `conversationKey`s.
 *
 * The one place the panel reads a published record, and it reads it to refuse
 * something, not to draw or drive it. The board holds only this window's
 * sessions, so without the records a picker here would offer a conversation
 * another window is running, and a resume would start a second child on one
 * transcript.
 *
 * On picker open, never on the poll: one `readdir` of `live/` when a reader
 * presses Resume. `dont-default-to-polling`.
 *
 * This window's own sessions come off the board, because the board is where
 * `sessionEnded` can be asked: a card whose child has exited can be resumed.
 *
 * A record is not evidence on its own. The join that makes it evidence is
 * `liveRecords`, in `core/published.ts` because the rule is that file's and
 * it can be tested there. Without it, an ended session in this window
 * re-enters through the records loop, and a window force-quit without
 * `closeAll` makes every conversation it ran unresumable for seven days, in
 * every window.
 *
 * `scanProcesses()` is the poll's own cached table: it spawns one `ps` every
 * few seconds regardless, so asking on picker open is free.
 */
async function liveConversations(panel: PanelActions): Promise<Set<string>> {
  const keys = new Set(
    panel.sessions
      .filter((s) => !!s.sessionId && !sessionEnded(s.pid))
      .map((s) => conversationKey(sessionBrand(s.brand), s.sessionId))
  );
  const [published, cached] = await Promise.all([readPublished(), scanProcesses()]);
  // Rows are advisory: a press asks `conversationOwner` again on a fresh
  // table and refuses while it cannot prove the conversation free. A cached
  // table that was incomplete is read once more, so a row is not offered as
  // free off a read that could have left its process out.
  const table = cached.complete ? cached : await scanProcesses(true);
  for (const { session } of liveRecords(published, table.starts)) {
    // A record with no `sessionId` names no conversation, so it can neither be
    // offered nor withheld. The join above has nothing to say about that.
    if (session.sessionId) {
      keys.add(conversationKey(sessionBrand(session.brand), session.sessionId));
    }
  }
  return keys;
}

type ListConversations = Extract<WebviewMessage, { type: 'listConversations' }>;

/**
 * What has been talked about in this repository before, in every checkout of
 * it, because that is what the group the picker opened from stands for.
 *
 * Read here and not in the poll: it is a directory of transcripts, tailed one
 * by one, and nothing on the board depends on the answer.
 *
 * An ask with no cursor is an open: it ranks the family once and holds that
 * ranking as the panel's snapshot (`core/conversation_pages.ts`), replacing
 * any other. Page 1, or a kept query's page 1 after a restart, is posted
 * before the read's maintenance starts. An ask
 * with a cursor is a slice of the snapshot it names, or `expired` once the
 * panel no longer holds it.
 *
 * Every live session's id is marked on every page, this window's and everyone
 * else's. The rest come from one read of the published records (see
 * `liveConversations`).
 */
export async function listConversations(
  panel: PanelActions,
  ask: ListConversations
): Promise<void> {
  if (!ask.cwd) {
    return;
  }
  if (ask.cursor) {
    await listPage(panel, ask, ask.cursor);
    return;
  }
  const { cwd } = ask;
  // The read starts first: it takes its place in arrival order, so a slow live
  // read cannot let an older ask supersede the one the picker is waiting on.
  const reading = panel.conversationReader.read(cwd);
  const [live, read] = await Promise.all([liveConversations(panel), reading]);
  const ranking = pages.rank(await pages.named(read.rows), cwd);
  if (panel.disposed || !read.current()) return;
  const snapshotId = crypto.randomUUID();
  panel.conversationSnapshots.hold(snapshotId, cwd, ranking);
  panel.post(conversationsPage(ask, snapshotId, 0, pages.page(ranking, 0, ask.query), live));
  void read.maintain();
}

async function listPage(
  panel: PanelActions,
  ask: ListConversations,
  cursor: ConversationCursor
): Promise<void> {
  const ranking = panel.conversationSnapshots.ranking(cursor.snapshotId, ask.cwd);
  if (!ranking) {
    panel.post({
      type: 'conversations',
      requestId: ask.requestId,
      cwd: ask.cwd,
      snapshotId: cursor.snapshotId,
      offset: cursor.offset,
      rows: [],
      expired: true
    });
    return;
  }
  const found = pages.page(ranking, cursor.offset, ask.query);
  const live = await liveConversations(panel);
  if (panel.disposed) return;
  panel.post(conversationsPage(ask, cursor.snapshotId, cursor.offset, found, live));
}

/**
 * One page as the picker draws it. A conversation whose session is running
 * cannot be resumed (two children over one transcript), but it is often the
 * one being looked for, so the row is marked rather than dropped and `resume`
 * reveals its card instead. Its title is already the stated name when it has
 * one, captured when the snapshot was ranked.
 */
function conversationsPage(
  ask: ListConversations,
  snapshotId: string,
  offset: number,
  found: { rows: Conversation[]; next?: number },
  live: ReadonlySet<string>
): ConversationsMessage {
  return {
    type: 'conversations',
    requestId: ask.requestId,
    cwd: ask.cwd,
    snapshotId,
    offset,
    rows: found.rows.map((c) => {
      const where = checkoutLabel(ask.cwd, c.cwd);
      return {
        ...c,
        running: live.has(conversationKey(c.brand, c.sessionId)) || undefined,
        ...(where === undefined ? {} : { where })
      };
    }),
    ...(found.next === undefined ? {} : { next: { snapshotId, offset: found.next } })
  };
}

/**
 * Carries on a conversation that already exists: a new child on the same
 * transcript, in the window that owns the directory.
 *
 * A start, not a revival. The CLI keeps the id and keeps appending to the same
 * file (observed 2.1.220), so the new card shows the old turns and only the
 * pid is new. Any dead card still holding that id is dropped, because two
 * cards over one transcript would show the same turns twice. `dropSession`
 * refuses a live entry, so that loop cannot remove a running session's card.
 *
 * The live guard is asked again here, not trusted from the picker: a picker's
 * rows are as old as the poll that built them, and a second child on a running
 * conversation's transcript is not something to discover afterwards. The
 * `name` is only a decoration and rides in from the pressed row: `--name` is
 * read at start and never again, so it must be restated or the card comes up
 * called after its directory.
 */
export async function resume(
  panel: PanelActions,
  ask: {
    requestId: string;
    cwd: string;
    sessionId: string;
    name?: string;
    /** The row's opening prompt, for a conversation nobody ever named. Labels
     *  the card and stays off the command line, exactly as a draft's does. */
    placeholder?: string;
    /**
     * What this resume starts on, whole. `''` for `model` is the account's own
     * default, and an absent `effort` sends no override.
     *
     * A resume states its own pick because no start path reads a setting, so a
     * resume that stated nothing would silently take the account default. The
     * picker sends the settings: the model dropped when it names another
     * brand, because the picker has no model control of its own, and the
     * effort kept whatever the brand, because an effort names no brand's model.
     */
    target?: LaunchTarget;
  }
): Promise<void> {
  const key = conversationKey(sessionBrand(ask.target?.brand), ask.sessionId);
  let opening = pendingResumes.get(key);
  if (opening) {
    aliasStartup(ask.requestId, opening.id);
    const previous = await opening.result;
    if (!previous.ok && previous.unsure) await reconcileStart(opening.id);
    const reconciled = startupStatus(opening.id).result;
    if (reconciled?.ok === false && reconciled.notStarted && pendingResumes.get(key) === opening)
      pendingResumes.delete(key);
  }
  if (!opening) {
    const result = resumeConversation(panel, ask).catch((error: unknown): StartResult => ({
      ok: false,
      unsure: true,
      reason: error instanceof Error ? error.message : 'The conversation could not be resumed.'
    }));
    opening = { id: ask.requestId, result };
    pendingResumes.set(key, opening);
    void result.then((settled) => {
      if ((settled.ok || settled.notStarted) && pendingResumes.get(key)?.id === ask.requestId)
        pendingResumes.delete(key);
    });
  }
  const received = await opening.result;
  const result = startupStatus(opening.id).result ?? received;
  if (panel.disposed) return;
  panel.post(
    result.ok
      ? {
          type: 'resumeResult',
          requestId: ask.requestId,
          attemptId: opening.id,
          ok: true,
          pid: result.pid,
          startedAt: result.startedAt
        }
      : {
          type: 'resumeResult',
          requestId: ask.requestId,
          attemptId: opening.id,
          ok: false,
          reason: result.reason,
          ...(result.notStarted ? { notStarted: true } : {}),
          ...(result.unsure ? { unsure: true } : {})
        }
  );
  if (result.ok) revealSession(panel, result.pid, result.startedAt);
}

async function resumeConversation(
  panel: PanelActions,
  ask: Parameters<typeof resume>[1]
): Promise<StartResult> {
  const { cwd, sessionId, name, placeholder } = ask;
  const brand = sessionBrand(ask.target?.brand);
  const pick: LaunchTarget = { ...ask.target, brand };
  if (!cwd || !sessionId) {
    return { ok: false, notStarted: true, reason: 'Choose a conversation to resume.' };
  }
  const running = panel.sessions.find(
    (s) => s.sessionId === sessionId && sessionBrand(s.brand) === brand && !sessionEnded(s.pid)
  );
  if (running) {
    vscode.window.setStatusBarMessage(
      'That conversation is still running — its card is on the board.',
      STATUS_MS
    );
    return { ok: true, pid: running.pid, startedAt: running.startedAt, brand };
  }

  const started = await startOwned({
    attemptId: ask.requestId,
    cwd,
    resume: sessionId,
    name,
    placeholder,
    target: pick
  });
  if (!started.ok) {
    return started;
  }
  for (const past of panel.sessions) {
    if (
      past.sessionId === sessionId &&
      sessionBrand(past.brand) === brand &&
      past.pid !== started.pid
    ) {
      dropSession(past.pid);
    }
  }
  nudgeDiscovery(panel);
  return started;
}

/**
 * A start is the one moment the panel knows a session is coming, so it looks
 * sooner than the poll would — the card the webview is spinning over cannot
 * arrive before discovery sees it.
 */
export function nudgeDiscovery(panel: PanelActions): void {
  for (const delay of [600, 1400, 2600]) {
    setTimeout(() => {
      if (!panel.disposed) {
        void panel.refresh();
      }
    }, delay);
  }
}

/**
 * A reference to a session, on the clipboard, for pasting into another one's
 * prompt: its pid to message it by and its transcript to read
 * (`core/session_ref.ts`).
 */
export async function copyRef(panel: PanelActions, pid: number): Promise<void> {
  const session = panel.sessions.find((s) => s.pid === pid);
  // Both outcomes of the one control speak in the same place, so a failed copy
  // is read where a done copy would have been. A toast to dismiss is in the
  // way of the paste either way.
  if (!session) {
    vscode.window.setStatusBarMessage(`Session ${pid} is no longer running.`, STATUS_MS);
    return;
  }
  await vscode.env.clipboard.writeText(refFor(session.pid, session.transcript));
  vscode.window.setStatusBarMessage(`Copied a reference to ${session.name}.`, STATUS_MS);
}
