/**
 * Friend surface: fields and shell methods an extracted host verb may touch.
 *
 * OverviewPanel satisfies this structurally (package-visible fields +
 * refresh/post). It is a deliberate keyhole for H56 extracts — not a free
 * write API for arbitrary host code. Grow this type only when a verb body
 * truly needs another field. Prefer passing explicit args when an extract
 * needs ≤5 of these; use this type when it needs more.
 *
 * Auth (login, MCP, usage busy-set) is not here: `AuthState` on the panel,
 * owned by `panel_auth`. Delete that type and the cluster lands back on
 * this surface, where nothing stops the next verb writing `mcpHealth`.
 *
 * Who may write: host verb modules (`session_*`, `runs`, `workflow_actions`,
 * `panel_auth`, …). Everyone else goes through OverviewPanel methods or gets
 * values passed in — do not treat public fields as the extension surface.
 */
import * as vscode from 'vscode';
import { Confirmations } from '../ui/confirmations';
import { Session } from '../core/model';
import { RunnerOffer } from '../core/devservers/runners';
import type { PinnedSocket } from '../core/devservers/listeners';
import { Model } from '../core/model_names';
import type { Recent } from '../core/transcript';
import type * as conversations from '../core/conversations';
import type * as conversationPages from '../core/conversation_pages';

export type PanelActions = {
  confirmations: Confirmations;
  sessions: Session[];
  selected: number | undefined;
  selectedStartedAt: number | undefined;
  runners: Map<string, RunnerOffer>;
  /**
   * The last machine-wide listener reading, the two clocks that pace it — when
   * one was last *started*, and when one last *landed*, both on
   * `performance.now()` — and whether one is running right now. Why that third
   * one is not what either clock already says, and when it lets go:
   * `heardListeners` (`host/runs.ts`).
   *
   * Held here rather than as a module-level cache in `runs.ts` for the reason
   * `runners` is: it belongs to a panel's lifetime, so it is disposed with one
   * and can be arranged by a test. **Not** because a module cache would leak
   * across windows — each window is its own extension host, so it would not.
   * What that does mean is that N open windows each pay the reading: one
   * spawn per window per `LISTENERS_MS`, which is the known cost of putting
   * it here rather than in a file every window shares.
   */
  listeners?: { startedAt: number; foundAt: number; inflight: boolean; found: PinnedSocket[] };
  lastRunPicker?: { cwd: string; tree: string; branch: string; runnerId?: string };
  disposables: vscode.Disposable[];
  renderedThread?: {
    recent: Recent;
    view: { exchanges: ExchangeView[]; truncated: boolean; fallback?: true };
  };
  disposed: boolean;
  conversationReader: conversations.ConversationReader;
  /** The resume picker's one snapshot: replaced per open, dropped on dispose. */
  conversationSnapshots: conversationPages.ConversationSnapshots;
  /** The webview panel — reveal, postMessage for image bytes. */
  panel: vscode.WebviewPanel;
  refresh(): Promise<void>;
  post(message: PanelMessage): void;
  /** Every brand's start list, concatenated. The thread filters by brand. */
  models: Model[];
};
