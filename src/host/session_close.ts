/** Extracted from host/panel.ts — session close verbs (H56). */
import * as vscode from 'vscode';
import { ReapOwner, snapshotTree } from '../core/control';
import { Session } from '../core/model';
import { scanProcesses } from '../core/scan';
import {
  dropSession,
  ownedSession,
  endSession,
  isEnding,
  sessionExited,
  signalEnd
} from './sessions';
import * as sessionEnd from '../core/session_end';
import { ask } from '../core/coordination/ask';
import { configuredPathFor } from './cli_path';
import { closePlan, selectionEnded } from '../ui/closing';
import { hasExchanges } from '../core/adapter';
import { PanelActions } from './panel_actions';
import { sameSessionStart } from '../core/model';

/**
 * Ends a session on the one click. Its card stays, ending, until the process
 * is seen to go (`host/sessions.ts`).
 *
 * Decisions (dismiss / confirm / cascade / skip-confirm) live in
 * `ui/closing.ts` so a test can pin them. This method gathers, runs the
 * confirm port, and executes the kill routes — route stays thin (pipe /
 * signal); the broker will shrink it further.
 */
export async function closeSession(
  panel: PanelActions,
  pid: number,
  startedAt: number
): Promise<void> {
  const session = panel.sessions.find((s) => s.pid === pid);
  if (!session || session.startedAt !== startedAt) return;
  const held = ownedSession(pid);
  // Owned and already exited: dismiss before any scan or transcript read —
  // same order as before the plan extract. Measured without dropping so
  // `closePlan` stays pure; `dropSession` runs on execute.
  const alreadyDead = sessionExited(pid, session.startedAt);
  const facts = {
    alreadyDead,
    // Memory for a session this window drives, the files for a background one:
    // the dock's two sources, so End and the dock never disagree about whether
    // there is anything to lose.
    hasExchanges: alreadyDead
      ? false
      : await hasExchanges(
          session,
          held && sameSessionStart(held.state.startedAt, session.startedAt) ? held : undefined,
          configuredPathFor(session)
        )
  };
  let plan = closePlan(session, panel.sessions, facts);
  if (plan.kind === 'confirm' && plan.countsProcesses) {
    // For the dialog's copy only, so an end that asks nothing waits on no `ps`.
    // The confirm blocks as long as the reader takes, and what gets signalled
    // is rescanned by both end routes after the answer.
    const processCount = snapshotTree(pid, await scanProcesses(true)).length;
    plan = closePlan(session, panel.sessions, { ...facts, processCount });
  }

  let cascade: Session[] = [];
  switch (plan.kind) {
    case 'noop':
      return;
    case 'dismiss':
      // A session of ours that already died on its own: no child to signal,
      // no terminal to dispose, nothing left to confirm away.
      if (dropSession(pid, session.startedAt)) {
        reportAcceptedEnds(panel, [{ pid: session.pid, startedAt: session.startedAt }]);
      }
      return;
    case 'confirm': {
      const choice = await panel.confirmations.ask({
        title: plan.message,
        detail: plan.detail,
        actions: plan.buttons.map((label) => ({ id: label, label, destructive: true }))
      });
      // Dismissed does nothing. Both cascade offers are real choices: ending
      // an orchestrator while its peers keep working is legitimate.
      if (choice === undefined || plan.cascadeFor[choice] === undefined) {
        return;
      }
      // Exactly the sessions the dialog accounted for: the whole descent,
      // named up to three and counted past that. A session whose own parent
      // is already off the board is in nobody's descent, so it is not here —
      // it survives as a loose card, visible and recoverable.
      cascade = plan.cascadeFor[choice] ?? [];
      break;
    }
    case 'stop':
      cascade = plan.cascade;
      break;
  }

  // Everything below signals by pid, and the modal above blocks for as long as
  // the reader takes: a session that exited while it was up leaves a number the
  // kernel is free to hand to something else. So each of these is re-checked
  // against the poll's own reading, which is at most one interval old and
  // start-matched by `discover` — the same identity rule `processes.signal`,
  // `arrange.ts` and the published join all use, applied to the list a click
  // captured. A card that no longer answers to its start time is not ended;
  // it is gone, and the repaint at the end says so.
  if (panel.disposed) return;
  const live = new Map(panel.sessions.map((s) => [s.pid, s.startedAt]));
  if (!sameSessionStart(live.get(pid), session.startedAt)) {
    void panel.refresh();
    return;
  }
  cascade = cascade.filter((child) => sameSessionStart(live.get(child.pid), child.startedAt));

  const targets = [session, ...cascade].map(({ pid, startedAt }) => ({
    pid,
    startedAt,
    windowId: vscode.env.sessionId
  }));
  const results = await sessionEnd.endSessions(targets, {
    local: {
      windowId: vscode.env.sessionId,
      owned: ownedSession,
      end: endSession,
      ending: isEnding
    },
    ask,
    observe: sessionEnd.observeEnds,
    signal: (targets) => signalEnd(targets, panelReaps(panel))
  });
  const reported = results.flatMap(({ target, outcome }) => {
    if (outcome.ok) return [target];
    void vscode.window.showErrorMessage(`Could not end session ${target.pid}.`);
    return [];
  });
  reportAcceptedEnds(panel, reported);
  void panel.refresh();
}

/**
 * Clear a matching selection, tell the open chat, and refresh.
 * One operation for a registry end and for the outcomes `endSession` does not see.
 */
export function reportAcceptedEnds(
  panel: PanelActions,
  sessions: readonly { pid: number; startedAt: number }[]
): void {
  if (sessions.length === 0) return;
  if (selectionEnded(panel.selected, panel.selectedStartedAt, sessions)) {
    panel.selected = undefined;
    panel.selectedStartedAt = undefined;
  }
  panel.post({
    type: 'closeResult',
    sessions: sessions.map(({ pid, startedAt }) => ({ pid, startedAt }))
  });
  void panel.refresh();
}

/**
 * The panel as a reap's owner: a panel closed inside the grace cancels the
 * SIGKILL, because the reap is a signal and must not be sent by a panel nobody
 * asked to keep working.
 */
function panelReaps(panel: PanelActions): ReapOwner {
  return {
    hold: (reap) => panel.disposables.push(reap),
    release: (reap) => {
      const at = panel.disposables.indexOf(reap);
      if (at !== -1) {
        panel.disposables.splice(at, 1);
      }
    }
  };
}
