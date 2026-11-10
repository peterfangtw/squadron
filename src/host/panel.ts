import * as ticketRefs from '../core/ticket_ref';
import * as markdown from './markdown';
import * as conversations from '../core/conversations';
import * as conversationPages from '../core/conversation_pages';
import * as threadSync from '../ui/thread_sync';
import * as fileOpen from '../ui/file_open';
import { reconcileStartup } from './session_open';
import * as skills from './skills';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Confirmations } from '../ui/confirmations';
import * as ticketDisconnect from '../ui/ticket_disconnect';
import {
  adapter,
  adapterFor,
  brandForStart,
  discoverAll,
  offeredModels,
  publishable,
  ownedStamp
} from '../core/adapter';
import { BRANDS } from '../core/brands';
import { startOutcome } from '../core/start_outcome';
import * as modelListings from '../core/model_listing';
import { windowTokens } from '../core/catalog';
import { Session } from '../core/model';
import * as platform from '../core/platform';
import { brandName } from '../core/accounts';
import { skillStatus, skillTarget } from '../core/skill_install';
import * as warm from '../core/warm';
import { warmSettingWrite } from '../core/warm_policy';
// Import the leaf: claude/models would pull a maintenance tool into the runtime bundle.
import { modelEfforts, type Model } from '../core/model_names';
import {
  onOwnedChange,
  onOwnedEnd,
  onOwnedThreadChange,
  ownedSession,
  ownedSessions,
  endingSessions,
  readWarmPolicy
} from './sessions';
import { onSessionState } from './watch';
import type { RemoteHost } from './remote';

import {
  killListener,
  openRunPicker,
  reanswerRunPicker,
  runServerHere,
  serverContext,
  stopRun
} from './runs';
import { closeSession, reportAcceptedEnds } from './session_close';
import { openDiff } from './diff';
import { openPathSetting } from './cli_path';
import {
  buildThread,
  dismissQueued,
  fetchImage,
  interruptSession,
  openImage,
  pickFiles,
  renameSession,
  respondRequest,
  sendMessage,
  sendNow,
  setWarmSession
} from './session_io';
import { copyRef, listConversations, openSession, resume, revealSession } from './session_open';
import {
  cancelWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  retryWorkflow,
  saveWorkflow,
  writeWorkflowOrder
} from './workflow_actions';
import {
  accountsView,
  brandAvailability,
  cancelLogin,
  cancelMcpLogin,
  confirmSignOut,
  emptyAuth,
  forceAuth,
  mcpDisconnect,
  mcpForWire,
  refreshMcpHealthNow,
  refreshMcpIfDue,
  openInstallPage,
  openLoginUrl,
  refreshAuthIfDue,
  refreshUsage,
  startLogin,
  startMcpLogin,
  waitingUsageWindows,
  type AuthState
} from './panel_auth';

import { HeldAcks, markSeen, writeAck } from '../core/acks';
import * as scratch from '../core/scratch';
import { clearArrangements, readArrangements, writeArrangement } from '../core/arrange';
import { effectiveTheme, readRepoTheme, writeRepoTheme } from '../core/repo_theme';
import { cardCompletion } from '../core/claude/checklist';
import {
  liveBranchFields,
  readCheckout,
  repoRoots,
  withProcessCwd,
  type HeadPass
} from '../core/git';
import { processCwds } from '../core/devservers/listeners';
import { readStatedNames } from '../core/names';
import { RunnerOffer } from '../core/devservers/runners';
import { readWorkflowIndex } from '../core/workflows/workflows';
import { readWorkflowOrder } from '../core/workflows/workflow_order';
import { readProgress, workflowCompletion, workflowDates } from '../core/workflows/progress';
import type { Recent } from '../core/transcript';
import { panelDocument } from '../ui/document';
import {
  buildState,
  commitOwnedBoard,
  ownedDiscoveryKey,
  ownedLifecycleKey,
  stateKey
} from '../ui/state';
import { shorten } from '../ui/text';
import { displayName, foldTwins, groupKey, newlyWaiting, onBoard, soundCue } from '../ui/views';
import { sameSessionStart } from '../core/model';
import * as backlog from '../core/backlog';
import * as tickets from '../core/tickets';
import * as linear from '../core/tickets/linear';
import * as github from '../core/tickets/github';
import * as connections from '../core/tickets/connections';
import { webUri } from '../core/web';
import { accountsNotAdded, allowlistNotSaved, remoteStateView } from '../ui/remote_view';
import {
  CpuMeter,
  MemoryReading,
  cpuSample,
  machineView,
  meter,
  readMemory
} from '../core/machine';
import { record, RefreshVia } from '../core/perf';
import { invalidate as invalidateUsage } from '../core/usage';
import { cafeView, readHolds } from '../core/awake';
import { readClaims } from './windows';

/**
 * How long a memory reading is kept before another is asked for. Twelve
 * seconds: RAM moves at nothing like the load's speed, and on darwin the
 * question costs a spawn.
 *
 * **Wall clock, not a count of refreshes**, and that distinction is the whole
 * of why this constant is milliseconds. `refresh()` is not the 3s poll — it has
 * some forty callers, among them `host/watch.ts`'s 500ms nudge and `nudgeOwned`'s
 * own limit, so one streaming session would drive a counted-every-fourth
 * throttle to a spawn far inside this window. `core/machine.ts` states this same hazard
 * as the reason `MIN_WINDOW_MS` exists, and this is that floor's twin.
 */
const MEMORY_MS = 12_000;

/**
 * An unchanged board still needs a push for the machine dials and surfaces
 * that recover on the next push: held menus, timed-out server stops, and
 * ageing composer echoes. `ready` clears `lastState` for a rebuilt document.
 * Do not give the dials their own push without preserving this recovery bound.
 */
const UNCHANGED_MS = 15_000;

/**
 * Hidden polls continue so waiting and sound notifications reach a reader
 * behind another tab. `refreshOnce` skips drawing there.
 */
const POLL_MS = 3000;
const HIDDEN_POLL_MS = 15_000;

/**
 * Where a ticket source's GraphQL lives. Its own unless the reader has written
 * the entry's endpoint setting into their *user* settings, and nothing in the
 * product does: the settings are undeclared in `package.json`, so they are not
 * in the Settings UI and no reader will meet them. They exist for `test/smoke`,
 * which points a real host at a canned reply on localhost — the alternative was
 * a real account and a real key inside the suite that gates every deploy.
 *
 * `inspect` rather than `get` so the scope is ours to choose: which value wins,
 * and why a repo's own is not one of them, is the entry's `endpoint` in `core`
 * (`trackerEndpoint`), where it is a test rather than a claim.
 */
function ticketEndpoint(entry: tickets.TicketConnector): string {
  return entry.endpoint(
    vscode.workspace.getConfiguration('squadron').inspect<string>(entry.endpointSetting)
  );
}

/**
 * Each source's connect prompts, host-side because they are `vscode` UI. Each
 * resolves to the record its entry encoded, or nothing on a cancel or once
 * `current` says the panel moved on. Kept in the OS keychain — never in
 * settings, which sync and show in plain text.
 */
const CONNECT_PROMPTS = new Map<string, (current: () => boolean) => Promise<string | undefined>>([
  [linear.SOURCE_ID, promptLinear],
  [github.SOURCE_ID, promptGithub]
]);

async function promptLinear(): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: 'Connect Linear',
    prompt: 'Paste a Linear personal API key. Kept in the OS keychain, not in settings.',
    placeHolder: 'lin_api_…',
    password: true,
    ignoreFocusOut: true
  });
  const trimmed = key?.trim();
  return trimmed ? linear.CONNECTOR.encode({ apiKey: trimmed }) : undefined;
}

async function promptGithub(current: () => boolean): Promise<string | undefined> {
  const setup = await vscode.window.showQuickPick(
    [
      {
        label: 'Create a classic token for private repository issues',
        detail:
          'Select read:project and the top-level repo scope to read private issues. GitHub bundles write, deployment and invitation access into repo; Squadron only reads projects and issues.',
        scopes: 'read:project,repo'
      },
      {
        label: 'Create a classic token for public repository issues',
        detail:
          'Select only read:project to read projects and public issues. No repo scope is needed; private issues will stay hidden.',
        scopes: 'read:project'
      },
      {
        label: 'I have a classic token',
        detail:
          'Needs read:project; add the top-level repo scope only for private issues. No separate deployment or invitation scopes are needed. Authorize organization SSO if required.',
        scopes: undefined
      }
    ],
    {
      title: 'Connect GitHub Projects — token setup',
      placeHolder:
        'Use a personal access token (classic). Choose a link to create one, or continue with yours.',
      ignoreFocusOut: true
    }
  );
  if (!setup || !current()) return undefined;
  if (setup.scopes) {
    await vscode.env.openExternal(
      vscode.Uri.parse(
        'https://github.com/settings/tokens/new?description=Squadron&scopes=' +
          encodeURIComponent(setup.scopes)
      )
    );
    if (!current()) return undefined;
  }
  const owner = await vscode.window.showInputBox({
    title: 'Connect GitHub Projects',
    prompt: 'GitHub organization or user login whose projects to list.',
    ignoreFocusOut: true,
    validateInput: github.ownerProblem
  });
  if (!owner?.trim() || !current()) return undefined;
  const token = await vscode.window.showInputBox({
    title: 'Connect GitHub Projects',
    prompt:
      'Paste a classic token with read:project; add the top-level repo scope only for private issues. Squadron only reads projects and issues. Kept in the OS keychain.',
    password: true,
    ignoreFocusOut: true,
    validateInput: github.tokenProblem
  });
  if (!token?.trim()) return undefined;
  return github.CONNECTOR.encode({ owner: owner.trim(), token: token.trim() });
}

/** Workspace-storage key for the ticket filter the reader last picked. */

/** Per-workspace café position: placement on one project does not apply to another. */
const CAFE_KEY = 'cafe.at';
const ONBOARDING_KEY = 'onboarding.done';

/** Wire `FlagKey` → `squadron.*` configuration key. */
const FLAG_SETTING: Record<FlagKey, string> = {
  orchestrators: 'orchestrators.enabled',
  skipPermissions: 'skipPermissions.enabled',
  cafe: 'cafe.enabled',
  cafeRemote: 'cafe.remote',
  cafeWarm: 'cafe.warm',
  devServers: 'devServers.enabled',
  mascot: 'mascot.enabled',
  warmCache: 'warmCache.enabled',
  executionCapture: 'checkpoints.execution.enabled'
};

/**
 * Measured 2026-08-15: CLI text arrives in batches, 1.7–3.6 deltas/s with
 * p50 gaps of 316–546 ms. One second coalesces steady text as well as block
 * boundary bursts (up to eight frames in 100 ms in that trace).
 */
const OWNED_MS = 1000;

/**
 * A live half wearing the transcript it actually has, and the directory that
 * transcript says it lives in.
 *
 * `discover` locates a card's transcript; the frames reducer only derives one,
 * once, off `init` (`core/live.ts`) and never looks to see whether it is there.
 * So a cwd the CLI slugs differently — one behind a symlink, `/tmp` against
 * `/private/tmp` — names a file that has never existed, and the dock says the
 * conversation is gone. Both kinds of live half go through here, since a
 * published record carries its window's derivation and nothing more.
 *
 * **Whether that is worth a lookup is the CLI's answer, not this function's.**
 * `CliAdapter.locateTranscript` is absent for a brand whose file stays where it
 * was stated — Grok's `chat_history.jsonl`, Codex's thread id — and then the
 * session's own `transcript` stands. This used to be a `brand !== 'claude'`
 * here, which is the shape the seam exists to end.
 *
 * The step list rides along rather than being published with the record: no
 * frame carries one, so the window driving a session knows no more about its
 * list than any other window does — it is read from `~/.claude/tasks/<id>/` and
 * dated against the transcript, which is why it is read here, after the locating
 * that dating depends on. That directory is Claude's alone and `cardCompletion`
 * is where the other brands are turned away.
 *
 * Written onto the session rather than beside it: these records are built fresh
 * each poll, so nothing that outlives the pass is touched.
 */
async function relocate(session: Session): Promise<Session> {
  if (!session.sessionId) {
    return session;
  }
  // What goes in as `pinned` is `reduce.ts`'s derivation off the first `init`,
  // never this function's own previous answer: `relocate` writes onto a record
  // rebuilt every poll, and `core/live.ts` publishes the reduced state.
  //
  // **`home` is deliberately dropped on the floor.** Its one caller is the
  // owned-session pass below — the record pass went with row 71 — and those are
  // live halves built by `fromLive`, so they already carry `LiveState.originCwd`,
  // stated on the wire by the first `init` before the session could move. What
  // this used to do was overwrite that correct answer with the directory a
  // *file lookup* landed in, which is how a stale placement moved a card into
  // the group and branch of a checkout it had left half an hour earlier
  // (2026-08-17). `locateTranscript` still answers `home` for `discover.ts`,
  // whose cards have no pipe and so no origin to have watched.
  const cli = adapterFor(session);
  const located = await cli?.locateTranscript?.(session.cwd, session.sessionId, session.transcript);
  const transcript = located?.file ?? session.transcript;
  const completion = await cardCompletion(session, transcript);
  return Object.assign(session, {
    transcript,
    ...(completion === undefined ? {} : { completion })
  });
}

/**
 * Read the live branch after the process-cwd overlay, or a discover twin
 * that missed chdir could keep the chip on its origin. See `Session.liveWorktree`.
 */
async function withLiveBranch(session: Session, heads: HeadPass): Promise<Session> {
  if (!session.liveCwd || session.liveCwd === session.cwd) {
    return session;
  }
  const live = await readCheckout(session.liveCwd, heads);
  const fields = live && liveBranchFields(live);
  return fields ? Object.assign(session, fields) : session;
}

/** Whether each CLI has our agent skill, re-read every pass: three small
 *  files, and the only way to see the switch's install land and a reader's
 *  delete without a watcher on three trees. */
async function skillInstallView(): Promise<SkillInstallView[]> {
  const rows = await Promise.all(
    BRANDS.map(async (brand) => {
      const root = adapter(brand)?.skillRoot(os.homedir(), process.env);
      const state = root === undefined ? undefined : await skillStatus(...skillTarget(root));
      return state && { name: brandName(brand), state };
    })
  );
  return rows.filter((row) => row !== undefined);
}

/**
 * The checklist wins over workflow progress: it describes the session's
 * current work. Read progress only for a listless session. These session
 * records are fresh each pass, as in `relocate`.
 * `workflowCompletion` owns the tally and dates in core.
 */
async function workflowTallies(sessions: readonly Session[]): Promise<void> {
  // Only owned sessions: a session id can outlive its pipe, but the panel
  // must not draw a workflow strip it cannot drive.
  const listless = sessions.filter(
    (s) => s.completion === undefined && s.sessionId && s.source === 'owned'
  );
  if (listless.length === 0) {
    return;
  }
  await Promise.all(
    listless.map(async (session) => {
      const progress = await readProgress(session.sessionId ?? '');
      if (!progress) {
        return;
      }
      // See `workflowCompletion` for dating against the last prompt and opening.
      const dates = await workflowDates(session);
      const completion = workflowCompletion(progress, dates);
      if (completion) {
        Object.assign(session, { completion });
      }
    })
  );
}

/**
 * A file a turn wrote, opened the way that kind of file is worth looking at.
 *
 * A markdown file is what the reader asked the session to produce, so it opens
 * rendered rather than as source; an HTML mockup is only a mockup in a browser.
 * Everything else is code and belongs in an editor.
 * A link to a line opens source, where that position can be selected.
 *
 * Nothing is checked first. All three commands already report a path that has
 * gone, and a `stat` of ours would only reword them — where `openImage` warns
 * because it has a fallback to try before giving up.
 *
 * The path came through the webview, so it is not ours to trust — but every
 * branch here puts it through `Uri.file`, which forces the file scheme. That is
 * what keeps `openExternal` from honouring the `command:` and `vscode:` schemes
 * it would honour if this parsed the string instead (see `webUri`).
 */
async function openWritten(file: string, line?: number, column = 1): Promise<void> {
  const uri = vscode.Uri.file(file);
  const ext = path.extname(file).toLowerCase();
  const opener = fileOpen.writtenFileOpener({ extension: ext, authority: uri.authority });
  if (line !== undefined) {
    if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) {
      return;
    }
    await vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(line - 1, column - 1, line - 1, column - 1)
    });
  } else if (opener === 'markdown') {
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  } else if (opener === 'external') {
    await vscode.env.openExternal(uri);
  } else {
    await vscode.commands.executeCommand('vscode.open', uri);
  }
}

/** Named pages the settings modal opens. The host holds the URL. */
const EXTENSION_PAGES: Record<
  Extract<WebviewMessage, { type: 'openExtensionPage' }>['page'],
  string
> = {
  marketplace: 'https://marketplace.visualstudio.com/items?itemName=peterfangtw.squadron',
  openvsx: 'https://open-vsx.org/extension/peterfangtw/squadron',
  survey: 'https://forms.gle/PLpMnk4pqNELtVTK7',
  issue: 'https://forms.gle/LMVrVNRGYb7SuzSQ6'
};

export class OverviewPanel {
  readonly confirmations = new Confirmations((message) => this.post(message));
  private static current: OverviewPanel | undefined;

  /** Set once at activation, so the panel can read the Linear key from the keychain. */
  static secrets: vscode.SecretStorage | undefined;

  /** Set beside it, and stamped into the document so the settings menu can name the build. */
  static version = '';

  /** The tab's title: the manifest's `displayName`, which `deploy.mjs` suffixes on a staging install. */
  static title = 'Squadron';

  /**
   * Per-workspace storage: a project's filter must not follow the reader
   * into another window.
   */
  static memory: vscode.Memento | undefined;

  /** One prerequisite for this installation, shared by every workspace window. */
  static globalMemory: vscode.Memento | undefined;

  /** This install's root, for the tab icon. Set at activation beside the rest. */
  static extensionUri: vscode.Uri | undefined;

  /** Remote in this window. Built at activation, panel-free, so it outlives
   *  every panel; absent draws Remote as unavailable. */
  static remote: RemoteHost | undefined;

  /** The Squadron output channel, for a Remote action that threw: the view says
   *  what state things are in, and this says why. */
  static log: (line: string) => void = () => undefined;

  static show(): void {
    if (OverviewPanel.current) {
      OverviewPanel.current.panel.reveal();
      return;
    }
    OverviewPanel.current = new OverviewPanel();
  }

  /** Last list the open panel heard from the CLIs, or empty if none is open.
   *  A spawn that omitted both flags resolves a parent reading against this. */
  static listedModels(): readonly Model[] {
    return OverviewPanel.current?.models ?? [];
  }

  static async modelListing(): Promise<modelListings.ModelListing> {
    // A failed query must say unknown, not reuse the panel's last-good sign-in.
    const host = { auth: emptyAuth() };
    await refreshAuthIfDue(host, { force: true, relist: true });
    return modelListings.modelListing(
      brandAvailability(host),
      modelEfforts(vscode.workspace.getConfiguration('squadron').get<unknown>('efforts'))
    );
  }

  /** Redraw the open panel. Skill discovery has nothing to redraw before one exists. */
  static refreshOpen(): void {
    void OverviewPanel.current?.refresh();
  }

  /** One source's connect flow, from a panel row, its key button or the palette. */
  static async connectTicketSource(provider: string): Promise<void> {
    const panel = OverviewPanel.current;
    const epoch = panel?.ticketEpoch;
    const identity = panel?.tickets.identity();
    const current = (): boolean =>
      OverviewPanel.current === panel &&
      (!panel || (epoch === panel.ticketEpoch && (!identity || panel.tickets.accepts(identity))));
    // One flow at a time: a second press before the held row's push lands
    // would otherwise queue a second prompt behind the first.
    if (panel?.ticketConnecting) return;
    const entry = connections.connector(provider);
    if (!entry) return;
    // Held on the panel, not the webview: only the host sees the prompt close
    // on a cancel.
    const held = provider;
    if (panel) {
      panel.ticketConnecting = held;
      void panel.refresh();
    }
    try {
      await OverviewPanel.runTicketConnect(entry, current);
    } finally {
      if (panel?.ticketConnecting === held) {
        panel.ticketConnecting = undefined;
        void panel.refresh();
      }
    }
  }

  private static async runTicketConnect(
    entry: tickets.TicketConnector,
    current: () => boolean
  ): Promise<void> {
    const prompt = CONNECT_PROMPTS.get(entry.offer.sourceId);
    if (!prompt || !current()) return;
    const record = await prompt(current);
    if (record === undefined || !current()) return;
    await OverviewPanel.secrets?.store(entry.secretKey, record);
    OverviewPanel.current?.resetTickets();
  }

  /**
   * Deletes a source's credential once the reader confirms. `panel` asks in
   * that panel's own modal; the palette asks natively, since the panel may be
   * hidden behind another tab where its modal would go unseen.
   */
  static async disconnectTicketSource(provider: string, panel?: OverviewPanel): Promise<void> {
    const entry = connections.connector(provider);
    const secrets = OverviewPanel.secrets;
    if (!entry || !secrets) return;
    const confirmed = await secrets.get(entry.secretKey);
    if (confirmed === undefined) return;
    const view = ticketDisconnect.disconnectConfirmation(entry);
    if ((await OverviewPanel.confirmChoice(view, panel)) !== ticketDisconnect.DISCONNECT_ACTION) {
      return;
    }
    // A reconnect while the dialog was up, here or in another window, is a
    // credential the reader never agreed to delete.
    if ((await secrets.get(entry.secretKey)) !== confirmed) return;
    // The keychain watch resets tickets, this window's included.
    await secrets.delete(entry.secretKey);
  }

  private static async confirmChoice(
    view: ConfirmationView,
    panel: OverviewPanel | undefined
  ): Promise<string | undefined> {
    if (panel) return panel.confirmations.ask(view);
    const picked = await vscode.window.showWarningMessage(
      view.title,
      { modal: true, detail: view.detail },
      ...view.actions.map((action) => action.label)
    );
    return view.actions.find((action) => action.label === picked)?.id;
  }

  /** @package host extracts */
  readonly panel: vscode.WebviewPanel;
  /** @package host extracts */
  readonly disposables: vscode.Disposable[] = [];

  private constructor() {
    const shots = OverviewPanel.extensionUri
      ? vscode.Uri.joinPath(OverviewPanel.extensionUri, 'media', 'onboarding')
      : undefined;
    this.panel = vscode.window.createWebviewPanel(
      'squadron.overview',
      OverviewPanel.title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // The onboarding screenshots, and nothing else on disk.
        localResourceRoots: shots ? [shots] : []
      }
    );
    // Use the themed pair, not the package PNG: a monochrome tab icon follows the theme.
    // Without extensionUri, leave the host's default icon.
    const root = OverviewPanel.extensionUri;
    if (root) {
      const mark = (theme: string) =>
        vscode.Uri.joinPath(root, 'media', `icon-editor-${theme}.svg`);
      this.panel.iconPath = { light: mark('light'), dark: mark('dark') };
    }
    void this.themeName().then((theme) => {
      if (this.disposed) return;
      this.panel.webview.html = panelDocument(
        OverviewPanel.version,
        shots
          ? {
              base: this.panel.webview.asWebviewUri(shots).toString(),
              cspSource: this.panel.webview.cspSource
            }
          : undefined,
        theme
      );
    });

    const selection = tickets.storedSelection(OverviewPanel.memory?.get(tickets.SELECTION_KEY));
    if (selection) this.tickets.restoreSelection(selection);

    // The poll is the safety net: process death emits no file event, so a
    // closed session is only seen when the next poll fails its liveness check.
    // `host/watch.ts` makes opens and status changes land near-instantly
    // instead, through the subscription below.

    this.pace();

    this.disposables.push(
      { dispose: () => clearInterval(this.poll) },
      // Repace on visibility and clear lastState before refreshing: a retained
      // document otherwise waits for a change. Hidden polling continues (POLL_MS).
      this.panel.onDidChangeViewState(() => {
        this.pace();
        // The document cannot see this for itself: `retainContextWhenHidden`
        // keeps it alive and a tab switch never touches its `visibilityState`,
        // which reports the window rather than the tab. Sent unconditionally
        // and before the gate below, because "nobody is looking" is precisely
        // the news the state message stops carrying — see `VisibleMessage`.
        this.post({ type: 'visible', visible: this.panel.visible });
        if (this.panel.visible) {
          this.lastState = undefined;
          this.lastThread = undefined;
          void this.refresh();
        }
      }),
      { dispose: onOwnedChange(() => this.nudgeOwned()) },
      // A thread is drawn only in the dock, so only the selected session's
      // moving it is worth a refresh — on the same trailing `OWNED_MS` timer as
      // the live half, so a delta that moves both costs one.
      {
        dispose: onOwnedThreadChange((pid) => {
          if (pid === this.selected) this.nudgeOwned();
        })
      },
      {
        dispose: onOwnedEnd((ended) => {
          if (!this.disposed) reportAcceptedEnds(this, [ended]);
        })
      },
      // Ignore live publishes: the panel folds no records. Keep the subscription
      // for other channels, since waits still need the watcher. See foldTwins below.
      {
        dispose: onSessionState((via) => {
          if (via === 'live') return;
          if (!this.disposed) {
            void this.refresh(via);
          }
        })
      },
      { dispose: () => clearTimeout(this.ownedTimer) },
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
        if (msg.type === 'ready') {
          this.tickets.closeDetail();
          this.confirmations.cancel();
          this.selectionEpoch++;
          // A new document needs the full state even when it equals the previous
          // document's. Clear the dedupe key before refreshing.
          this.lastState = undefined;
          this.lastThread = undefined;
          void this.refresh();
          if (this.selected !== undefined && this.selectedStartedAt !== undefined)
            this.post({ type: 'reveal', pid: this.selected, startedAt: this.selectedStartedAt });
        } else if (msg.type === 'select') {
          // Read before overwriting: acknowledge both the departed and opened cards.
          const left = this.selected;
          this.selectionRequest = msg.selection;
          this.selected = msg.pid || undefined;
          this.selectedStartedAt =
            ownedSession(msg.pid)?.state.startedAt ??
            this.sessions.find((session) => session.pid === msg.pid)?.startedAt;
          void this.opened(msg.pid, left);
        } else if (msg.type === 'threadSync' || msg.type === 'threadHistory') {
          if (
            msg.selection !== this.selectionRequest ||
            msg.pid !== this.selected ||
            msg.startedAt !== this.selectedStartedAt
          )
            return;
          if (msg.type === 'threadHistory') {
            if (msg.generation !== ownedSession(msg.pid)?.thread.generation()) return;
            this.fullHistory = msg.full;
            this.selectionEpoch++;
          }
          this.lastThread = undefined;
          this.syncedThread = undefined;
          void this.refreshThread();
        } else if (msg.type === 'refreshSkills') {
          void skills
            .refreshSkills()
            .catch((error: unknown) => OverviewPanel.log(`skill discovery: ${String(error)}`));
        } else if (msg.type === 'seen') {
          void this.opened(msg.pid);
        } else if (msg.type === 'send') {
          void sendMessage(
            this,
            msg.pid,
            msg.startedAt,
            msg.operationId,
            msg.text,
            msg.images,
            msg.workflowId,
            msg.target
          );
        } else if (msg.type === 'dismissQueued') {
          void dismissQueued(this, msg.pid, msg.startedAt, msg.id);
        } else if (msg.type === 'sendNow') {
          void sendNow(this, msg.pid, msg.startedAt);
        } else if (msg.type === 'image') {
          void fetchImage(this, msg.pid, msg.id);
        } else if (msg.type === 'openImage') {
          void openImage(this, msg.pid, msg.id);
        } else if (msg.type === 'openFile') {
          void openWritten(msg.path, msg.line, msg.column);
        } else if (msg.type === 'openDiff') {
          void openDiff(msg.path, msg.base);
        } else if (msg.type === 'pickFiles') {
          void pickFiles(this, msg.cwd, msg.operationId);
        } else if (msg.type === 'startup') {
          void reconcileStartup(this, msg.attemptId, msg.action === 'cancel');
        } else if (msg.type === 'open') {
          // Use the message's settled pick. Reading configuration again here would
          // answer a question the draft already settled.
          const asked = brandForStart(msg.target?.brand);
          if (!asked.ok) {
            // Not showWarningMessage: a draft says this on its own surface.
            if (msg.draftId !== undefined) {
              this.post({
                type: 'openResult',
                draftId: msg.draftId,
                ...startOutcome({ ok: false, outcome: 'stopped', reason: asked.reason })
              });
            }
            return;
          }
          // Every start belongs to this window. `target` passes through: a field
          // added to LaunchTarget is this message's, not one to copy here.
          void openSession(this, {
            cwd: msg.cwd,
            ...(msg.target === undefined ? {} : { target: msg.target }),
            ...(msg.placeholder === undefined ? {} : { placeholder: msg.placeholder }),
            ...(msg.draftId === undefined ? {} : { draftId: msg.draftId })
          });
        } else if (msg.type === 'listConversations') {
          void listConversations(this, {
            type: 'listConversations',
            requestId: msg.requestId,
            cwd: msg.cwd,
            ...(msg.cursor === undefined
              ? {}
              : { cursor: { snapshotId: msg.cursor.snapshotId, offset: msg.cursor.offset } }),
            ...(msg.query === undefined ? {} : { query: msg.query })
          });
        } else if (msg.type === 'resume') {
          void resume(this, {
            requestId: msg.requestId,
            cwd: msg.cwd,
            sessionId: msg.sessionId,
            ...(msg.name === undefined ? {} : { name: msg.name }),
            ...(msg.placeholder === undefined ? {} : { placeholder: msg.placeholder }),
            ...(msg.target === undefined ? {} : { target: msg.target })
          });
        } else if (msg.type === 'copyRef') {
          void copyRef(this, msg.pid);
        } else if (msg.type === 'confirmModalResult') {
          this.confirmations.answer(msg.requestId, msg.actionId);
        } else if (msg.type === 'close') {
          void closeSession(this, msg.pid, msg.startedAt);
        } else if (msg.type === 'interrupt') {
          void interruptSession(this, msg.pid, msg.startedAt);
        } else if (msg.type === 'respond') {
          void respondRequest(this, msg.pid, msg.startedAt, msg.requestId, msg.decision);
        } else if (msg.type === 'arrange') {
          void this.arrange(msg.cwd, msg.slots);
        } else if (msg.type === 'resetArrangement') {
          void clearArrangements().then(() => this.refresh());
        } else if (msg.type === 'setFlag') {
          void this.setFlag(msg.key, msg.on);
        } else if (msg.type === 'moveCafe') {
          // Do not echo the stored position: the webview already moved the node,
          // and a refresh would race the drag. The next poll carries it for reload.
          void OverviewPanel.memory?.update(CAFE_KEY, { x: msg.x, y: msg.y });
        } else if (msg.type === 'setModel') {
          void this.setModel(msg.model, msg.window);
        } else if (msg.type === 'setEffort') {
          void this.setEffort(msg.model, msg.effort);
        } else if (msg.type === 'rename') {
          void renameSession(this, msg.pid, msg.startedAt, msg.title);
        } else if (msg.type === 'setWarm') {
          void setWarmSession(this, msg.pid, msg.startedAt, msg.on);
        } else if (msg.type === 'setWarmSetting') {
          void this.setWarmSetting(msg.key, msg.minutes);
        } else if (msg.type === 'setTheme') {
          void this.setTheme(msg.theme);
        } else if (msg.type === 'setSound') {
          void this.setSound(msg.level);
        } else if (msg.type === 'connectTicketSource') {
          if (this.tickets.accepts(msg)) void OverviewPanel.connectTicketSource(msg.provider);
        } else if (msg.type === 'disconnectTicketSource') {
          if (this.tickets.accepts(msg)) {
            void OverviewPanel.disconnectTicketSource(msg.provider, this);
          }
        } else if (msg.type === 'ticketsOpen') {
          // Refresh on opening so the reader need not wait for the poll. Fetching
          // also serves the badge while closed, and the TTL still gates the network.
          if (msg.open) {
            void this.refresh();
          }
        } else if (msg.type === 'refreshTickets') {
          if (!this.tickets.accepts(msg)) return;
          this.tickets.refetchCatalog();
          void this.refresh();
        } else if (msg.type === 'refreshMcpHealth') {
          void refreshMcpHealthNow(this).then(() => this.refresh());
        } else if (msg.type === 'selectTicketScope') {
          if (!this.tickets.selectScope(msg.scopeId, msg)) {
            const { type: _type, ...token } = msg;
            this.post({ type: 'ticketScopeChoice', landed: false, ...token });
            return;
          }
          void this.refresh('tickets');
        } else if (msg.type === 'setTicketFilter') {
          const saved = this.tickets.setFilter(msg.filter, msg);
          if (!saved) return;

          void this.refresh();
        } else if (msg.type === 'openExtensionPage') {
          void vscode.env.openExternal(vscode.Uri.parse(EXTENSION_PAGES[msg.page]));
        } else if (msg.type === 'openTicketReference') {
          const [ref] =
            typeof msg.reference === 'string' ? ticketRefs.findTickets(msg.reference) : [];
          if (ref?.text === msg.reference) void vscode.env.openExternal(vscode.Uri.parse(ref.url));
        } else if (msg.type === 'openTicketLink') {
          const url = this.tickets.detailCurrent(msg.requestId) ? webUri(msg.url) : undefined;
          if (url) void vscode.env.openExternal(vscode.Uri.parse(url.href));
        } else if (msg.type === 'readTicket') {
          void this.readTicket(msg);
        } else if (msg.type === 'closeTicketDetail') {
          this.tickets.closeDetail(msg.requestId);
        } else if (msg.type === 'openTicket') {
          const target = this.tickets.openTarget(msg.key, msg);
          const url = target ? webUri(target) : undefined;
          if (url) void vscode.env.openExternal(vscode.Uri.parse(url.href));
        } else if (msg.type === 'openRunPicker') {
          // Gate new server work, never stopRun: switching off must not strand
          // a running server. A picker in another window can survive the flip.
          if (this.flag('devServers.enabled')) {
            void openRunPicker(this, msg.cwd, msg.tree, msg.branch, msg.runnerId);
          }
        } else if (msg.type === 'run') {
          if (this.flag('devServers.enabled')) {
            void runServerHere(this, msg.cwd, msg.tree, msg.runnerId, msg.branch, msg.port);
          }
        } else if (msg.type === 'stopRun') {
          // Re-answer occupancy after a stop from the sheet's held-port tile.
          void stopRun(this, msg.cwd, msg.runnerId).then((port) => reanswerRunPicker(this, port));
        } else if (msg.type === 'killListener') {
          if (this.flag('devServers.enabled')) {
            void killListener(this, msg.port, msg.pid, msg.startedAt, msg.command);
          }
        } else if (msg.type === 'openServer') {
          const url = webUri(msg.url);
          if (url) void vscode.env.openExternal(vscode.Uri.parse(url.href));
        } else if (msg.type === 'saveWorkflow') {
          void saveWorkflow(this, msg);
        } else if (msg.type === 'cancelWorkflow') {
          void cancelWorkflow(this, msg.pid, msg.startedAt);
        } else if (msg.type === 'retryWorkflow') {
          void retryWorkflow(this, msg.pid, msg.startedAt);
        } else if (msg.type === 'deleteWorkflow') {
          void deleteWorkflow(this, msg);
        } else if (msg.type === 'duplicateWorkflow') {
          void duplicateWorkflow(this, msg);
        } else if (msg.type === 'writeWorkflowOrder') {
          void writeWorkflowOrder(this, msg);
        } else if (msg.type === 'startLogin') {
          void startLogin(this, msg.brand);
        } else if (msg.type === 'installCli') {
          openInstallPage(msg.brand);
        } else if (msg.type === 'setCliPath') {
          openPathSetting(adapter(msg.brand));
        } else if (msg.type === 'onboardingDone') {
          void OverviewPanel.globalMemory?.update(ONBOARDING_KEY, true).then(() => this.refresh());
        } else if (msg.type === 'recheckClis') {
          void forceAuth(this);
        } else if (msg.type === 'cancelLogin') {
          cancelLogin(this);
        } else if (msg.type === 'submitLoginCode') {
          this.auth.login?.submit(msg.code);
        } else if (msg.type === 'openLoginUrl') {
          openLoginUrl(msg.url);
        } else if (msg.type === 'confirmSignOut') {
          void confirmSignOut(this, msg.brand);
        } else if (msg.type === 'startMcpLogin') {
          void startMcpLogin(this, msg.target, msg.operationId);
        } else if (msg.type === 'cancelMcpLogin') {
          cancelMcpLogin(this, msg.operationId);
          void this.refresh();
        } else if (msg.type === 'mcpLogout') {
          void mcpDisconnect(this, msg.target, msg.operationId);
        } else if (msg.type === 'setRemote') {
          void this.setRemote(msg.on);
        } else if (msg.type === 'setRemoteField') {
          void this.remoteAction('set a token', (remote) => remote.setField(msg.key));
        } else if (msg.type === 'forgetRemote') {
          void this.remoteAction('remove the tokens', (remote) => remote.forget());
        } else if (msg.type === 'checkRemote') {
          void this.remoteAction('check the setup', (remote) => remote.check());
        } else if (msg.type === 'setRemoteAllowlist') {
          void this.setRemoteAllowlist(msg.ids);
        } else if (msg.type === 'setRemoteSpace') {
          void this.remoteAction('set the space', (remote) => remote.setSpace(msg.value));
        } else if (msg.type === 'copyRemoteSetup') {
          void this.remoteAction('copy the setup text', async (remote) => {
            const copy = remote.messengerSetup().create?.copy;
            if (copy) await vscode.env.clipboard.writeText(copy.text);
          });
        } else if (msg.type === 'openRemoteSetupLink') {
          // The host's own entry names the page; no URL comes from the webview.
          void this.remoteAction('open the create page', async (remote) => {
            const url = webUri(remote.messengerSetup().create?.link ?? '');
            if (url) await vscode.env.openExternal(vscode.Uri.parse(url.href));
          });
        } else {
          // Keep exhaustiveness matched to host/request_host.ts: new variants must not silently drop.
          msg satisfies never;
        }
      }),
      this.panel.onDidDispose(() => this.dispose()),
      // The keychain, for the same reason the configuration is watched below:
      // this window's own connect fires it, and so does one in another window,
      // which is what the per-poll read used to cover.
      ...(OverviewPanel.secrets
        ? [
            OverviewPanel.secrets.onDidChange((e) => {
              if (connections.CONNECTORS.some((entry) => entry.secretKey === e.key)) {
                this.resetTickets();
              }
            })
          ]
        : []),
      // A link move, a refusal or a token stored lands now, not on the next
      // poll. The allowlist's setting arrives this way too: `RemoteHost`
      // re-reads it and fires.
      ...(OverviewPanel.remote
        ? [OverviewPanel.remote.onDidChangeView(() => void this.refresh('remote'))]
        : []),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          BRANDS.some((brand) => {
            const setting = adapter(brand)?.pathSetting;
            return setting && e.affectsConfiguration(`squadron.${setting}`);
          })
        ) {
          void forceAuth(this);
        }
        // Filter settings change the query, so its cached list and options no longer apply.
        if (
          connections.CONNECTORS.some((entry) =>
            e.affectsConfiguration(`squadron.${entry.settingsSection}`)
          )
        ) {
          this.resetTickets();
        }
        // The Settings UI, or another window, also changes these. Refresh now,
        // rather than waiting for a push.
        if (
          e.affectsConfiguration('squadron.theme') ||
          e.affectsConfiguration('squadron.warmCache') ||
          e.affectsConfiguration('squadron.mascot')
        ) {
          void this.refresh();
        }
      })
    );

    void this.refresh();
  }

  private selectedPid: number | undefined;
  private selectionEpoch = 0;
  private selectionRequest: string | undefined;
  private fullHistory = false;
  private syncedThread: { thread: ThreadView; publication: ThreadPublication } | undefined;
  private contentRevision = 0;

  get selected(): number | undefined {
    return this.selectedPid;
  }
  set selected(pid: number | undefined) {
    this.selectedPid = pid;
    this.fullHistory = false;
    this.syncedThread = undefined;
    this.selectionEpoch++;
    this.lastThread = undefined;
  }
  /** @package host extracts */
  selectedStartedAt: number | undefined;
  /** @package host extracts */
  sessions: Session[] = [];
  private primed = false;
  /** Opens of a pid whose id the last poll did not carry — see `HeldAcks`. */
  private readonly heldAcks = new HeldAcks();
  /** @package host extracts */
  disposed = false;
  /** @package host extracts */
  readonly conversationReader = new conversations.ConversationReader();
  /** @package host extracts */
  readonly conversationSnapshots = new conversationPages.ConversationSnapshots();
  /** The CPU counters as of the last poll wide enough to divide — see `meter`. */
  private cpu: CpuMeter = {};
  /** The last memory reading that came back, repainted until the next one does.
   *  Absent until the first read settles; `null` once one settled with nothing,
   *  which the nav draws as "-" rather than as a read still out. */
  private memory?: MemoryReading | null;
  /** Timestamp, not repaint count: see MEMORY_MS. Zero makes the first read due. */
  private memoryAt = 0;
  /**
   * Last process-cwd map for board pids. Same last-good as `heardListeners` in
   * `runs.ts`: a wedged `lsof` is 2s (`SPAWN_MS`) against this 3s poll, so the
   * paint path overlays whatever map is current and never awaits the spawn.
   * Empty success (killed, no `lsof`) leaves the previous map standing.
   */
  private processCwdCache: { found: Map<number, string>; inflight: boolean } = {
    found: new Map(),
    inflight: false
  };
  /** The dock's turns, beside the transcript reading they were built from — one
   *  object so the pair cannot tear, since `refresh` has some forty callers and
   *  two of them can be inside `rendered` at once. Holds one entry, which is the
   *  selected session's. See `rendered`. */
  /** @package host extracts */
  renderedThread?: {
    recent: Recent;
    view: { exchanges: ExchangeView[]; truncated: boolean; fallback?: true };
  };
  private poll: ReturnType<typeof setInterval> | undefined;
  /** The rate `poll` is currently running at, so `pace` is idempotent — the view
   *  state event fires for focus changes too, not only for visibility. */
  private polling: number | undefined;
  private ticketEpoch = 0;
  /** The source whose connect prompt is open; see `connectTicketSource`. */
  private ticketConnecting: string | undefined;
  /** The `order` of the last held-session reading posted (`publishable`). */
  private publishedRead = 0;
  private ownedKey: string | undefined;
  private threadMetadata: { pid: number; key: string } | undefined;
  private lastThread: string | undefined;
  private lastThreadAt = 0;
  private threadSequence = 0;
  private threadReading: Promise<void> | undefined;
  private threadAgain = false;
  private boardReading: Promise<void> | undefined;
  private readonly boardRequests = new Set<RefreshVia>();
  /** The last state key, without machine values. Undefined forces the first push. */
  private lastState?: string;
  private lastPostAt = 0;
  /** @package host extracts */
  models: Model[] = [];
  /**
   * Runner offers keyed by manifest mtimes and settings, for app directories
   * and trees. The cache dies with the panel.
   */
  /** @package host extracts */
  runners = new Map<string, RunnerOffer>();
  /**
   * The last picker target, so a stop can re-answer it. A shut sheet drops
   * a late answer by the same check that drops one for the wrong row.
   */
  /** @package host extracts */
  lastRunPicker?: { cwd: string; tree: string; branch: string; runnerId?: string };
  private ownedTimer: NodeJS.Timeout | undefined;
  /** Auth state stays off PanelActions so unrelated verbs cannot write mcpHealth. */
  auth: AuthState = emptyAuth();

  private nudgeOwned(): void {
    if (this.ownedTimer) {
      return;
    }
    this.ownedTimer = setTimeout(() => {
      this.ownedTimer = undefined;
      if (!this.disposed) {
        const key = this.discoveryKey(this.ownedCards());
        if (key !== this.ownedKey) void this.refresh('owned');
        // Pending requests and outbox changes need not move the discovery key.
        void this.refreshThread();
      }
    }, OWNED_MS);
  }

  /**
   * Ticket state belongs in core/backlog.ts. Supply the host-only keychain
   * key, settings defaults and panel lifetime here.
   */
  private configuredTickets: tickets.ConfiguredSource[] | undefined;

  private readonly tickets = new backlog.TicketStore({
    onDetailClosed: (requestId) => {
      if (!this.disposed) this.post({ type: 'ticketDetail', requestId, state: 'closed' });
    },
    onSelection: async (selection) => {
      await OverviewPanel.memory?.update(tickets.SELECTION_KEY, selection);
    },
    onChange: () => {
      if (!this.disposed) {
        void this.refresh('tickets');
      }
    }
  });

  private async readTicket(msg: Extract<WebviewMessage, { type: 'readTicket' }>): Promise<void> {
    try {
      const result = await this.tickets.readDetail(msg.key, msg, msg.requestId);
      if (!result) {
        if (this.tickets.accepts(msg))
          this.post({
            type: 'ticketDetail',
            requestId: msg.requestId,
            state: 'error',
            reason: 'This ticket is no longer available. Refresh the list and try again.'
          });
        return;
      }
      const { description, ...detail } = result;
      const html = await markdown.render(description, false);
      if (!this.tickets.detailCurrent(msg.requestId)) return;
      this.post({
        type: 'ticketDetail',
        requestId: msg.requestId,
        state: 'ready',
        detail,
        html,
        empty: !description.trim()
      });
    } catch (error) {
      if (!this.tickets.detailCurrent(msg.requestId)) return;
      this.post({
        type: 'ticketDetail',
        requestId: msg.requestId,
        state: 'error',
        reason:
          tickets.sourceError(error).kind === 'credentials'
            ? 'Your tracker connection needs to be updated.'
            : 'Could not load this ticket. Please try again.'
      });
    }
  }

  private flag(key: string, fallback = false): boolean {
    return vscode.workspace.getConfiguration('squadron').get<boolean>(key, fallback);
  }

  /** Remote as the panel draws it. A view that throws drops the field for one
   *  pass rather than the whole push. */
  private async remoteState(): Promise<RemoteStateView | undefined> {
    const remote = OverviewPanel.remote;
    if (!remote) return undefined;
    try {
      return remoteStateView(await remote.view(), remote.messengerSetup());
    } catch (error) {
      OverviewPanel.log(
        await remote.redact(`remote: the view could not be read — ${String(error)}`)
      );
      return undefined;
    }
  }

  /**
   * The switch, as `setFlag` settles a flag: `on` is the value asked and
   * `landed` is whether the view after the call agrees, so a refused turn-on
   * puts that flip back and a later press keeps its own.
   */
  private async setRemote(on: boolean): Promise<void> {
    const remote = OverviewPanel.remote;
    let agreed = false;
    if (remote) {
      try {
        await (on ? remote.turnOn() : remote.turnOff());
        agreed = remoteStateView(await remote.view(), remote.messengerSetup()).on === on;
      } catch (error) {
        OverviewPanel.log(
          await remote.redact(`remote: the switch did not move — ${String(error)}`)
        );
      }
    }
    this.post({ type: 'remoteChoice', on, landed: agreed });
    void this.refresh();
  }

  /** `RemoteHost.setAllowlist`. A save that fails, or an account the
   *  messenger refused, is said on the page, which drops the edits it holds:
   *  no push would ever agree with them. */
  private async setRemoteAllowlist(ids: readonly string[]): Promise<void> {
    await this.remoteAction(
      'save the allowed accounts',
      async (remote) => {
        const refused = await remote.setAllowlist(ids);
        const newest = refused.at(-1);
        if (newest) {
          this.post({
            type: 'remoteAllowlistFailed',
            reason: accountsNotAdded(refused),
            account: newest.account
          });
        }
      },
      (detail) => this.post({ type: 'remoteAllowlistFailed', reason: allowlistNotSaved(detail) })
    );
  }

  /** One of Remote's setup actions. A throw is logged, and `failed` hears
   *  its reason, none when that could not be redacted; otherwise the next
   *  view says what state things are in. */
  private async remoteAction(
    what: string,
    act: (remote: RemoteHost) => PromiseLike<unknown>,
    failed?: (detail: string | undefined) => void
  ): Promise<void> {
    const remote = OverviewPanel.remote;
    if (!remote) return;
    try {
      await act(remote);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      OverviewPanel.log(await remote.redact(`remote: could not ${what} — ${reason}`));
      failed?.(await remote.redacted(reason));
    }
  }

  /**
   * Write one board/agents flag to an absolute value. Global, because
   * `"scope": "application"` is the only target that takes for two of them and
   * the others are machine-wide in spirit anyway. Execution capture writes the
   * workspace value when one is stored, because that is what this window reads.
   *
   * Desired state rather than a flip, so a double-click cannot race the poll
   * that echoes the write. Refreshed rather than left to the poll, so the
   * switch shows the new value under the finger — and so do the cards, for the
   * flag that changes them.
   *
   * Answered with whether the setting reads back as asked. A write that
   * throws (a malformed settings.json), or a Global one a workspace value
   * overrides, would otherwise leave the reader's flip on screen with no push
   * ever agreeing.
   */
  private async setFlag(key: FlagKey, on: boolean): Promise<void> {
    const setting = FLAG_SETTING[key];
    const cfg = vscode.workspace.getConfiguration('squadron');
    const target =
      key === 'executionCapture' && cfg.inspect(setting)?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    let landed = false;
    try {
      await cfg.update(setting, on, target);
      landed = vscode.workspace.getConfiguration('squadron').get<boolean>(setting) === on;
    } catch (error) {
      OverviewPanel.log(`settings: ${setting} was not written — ${String(error)}`);
    }
    this.post({ type: 'flagChoice', key, on, landed });
    void this.refresh();
  }

  /**
   * Write one warm figure typed in the column. Global for `setFlag`'s reason:
   * the settings are `"scope": "application"`. The configuration listener
   * echoes the write, so this does not refresh too, as `setTheme` does not.
   * Answered as `setFlag` is.
   */
  private async setWarmSetting(key: unknown, minutes: unknown): Promise<void> {
    // Anything else names no field the panel could be holding.
    if (typeof key !== 'string' || typeof minutes !== 'number') return;
    const write = warmSettingWrite(key, minutes);
    let landed = false;
    if (write) {
      try {
        const cfg = vscode.workspace.getConfiguration('squadron.warmCache');
        await cfg.update(write.setting, write.minutes, vscode.ConfigurationTarget.Global);
        landed =
          vscode.workspace.getConfiguration('squadron.warmCache').get(write.setting) ===
          write.minutes;
      } catch (error) {
        OverviewPanel.log(
          `settings: warmCache.${write.setting} was not written — ${String(error)}`
        );
      }
    }
    this.post({ type: 'warmSettingChoice', key, minutes, landed });
  }

  /** An unrecognised level reads `normal` rather than refusing — a typo in the
   *  Settings UI should cost a reader their loudness, not their board. */
  private soundLevel(): SoundLevel {
    const read = vscode.workspace.getConfiguration('squadron').get<string>('sound.level');
    return read === 'off' || read === 'quiet' || read === 'loud' ? read : 'normal';
  }

  private async setSound(level: SoundLevel): Promise<void> {
    await vscode.workspace
      .getConfiguration('squadron')
      .update('sound.level', level, vscode.ConfigurationTarget.Global);
    void this.refresh();
  }

  /** Fill state only: each start carries its settled model on the message. */
  private modelSetting(): string {
    return vscode.workspace.getConfiguration('squadron').get<string>('model', '').trim();
  }

  /**
   * Read effort into the state push, not again at launch. It travels with
   * the draft or resume pick (TASK_done_launch_target.md).
   */
  private effortsSetting(): Record<string, string> {
    return modelEfforts(vscode.workspace.getConfiguration('squadron').get<unknown>('efforts'));
  }

  /** The window beside `modelSetting`, in tokens. `windowTokens` is what keeps
   *  a hand-edited `settings.json` from putting a string on the wire. */
  private windowSetting(): number | undefined {
    return windowTokens(
      vscode.workspace.getConfiguration('squadron').get<unknown>('contextWindow')
    );
  }

  /**
   * Record a model picked in the gear.
   *
   * Refreshed rather than left to the poll, for `setFlag`'s reason: the row
   * shows the new value under the finger. Nothing is validated — a bad id is
   * refused by the CLI at the next start and its stderr reaches that card,
   * which is where a reader can act on it.
   *
   * **`agentsview.cli` is not written here, and there is none left to write.**
   * The gear used to move it in step, or `+` started Claude on a Grok id; a
   * draft carries its own `brand` on the `open` now, read off the row that was
   * picked, so the brand travels with the model instead of being a second key
   * that could fall out of step with it.
   */
  private async setModel(model: string, window?: number): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('squadron');
    await cfg.update('model', model, vscode.ConfigurationTarget.Global);
    // Clear an absent window, or the previous pick would pin the new model.
    await cfg.update('contextWindow', window ?? null, vscode.ConfigurationTarget.Global);
    void this.refresh();
  }

  private async setEffort(model: string, effort: string): Promise<void> {
    await vscode.workspace
      .getConfiguration('squadron')
      .update(
        'efforts',
        { ...this.effortsSetting(), [model]: effort },
        vscode.ConfigurationTarget.Global
      );
    void this.refresh();
  }

  /**
   * Read the available catalog every pass: installing or signing into a CLI
   * changes the list. A latch would go stale.
   */
  private gatherModels(): Model[] {
    return offeredModels(brandAvailability(this));
  }

  /**
   * The folder's file when it has chosen, otherwise the shared setting.
   * A window with no folder has only the setting.
   */
  private async themeName(): Promise<ThemeName> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const stored = folder ? await readRepoTheme(folder) : undefined;
    return effectiveTheme(stored, vscode.workspace.getConfiguration('squadron').get('theme'));
  }

  /**
   * A folder's pick is a file, not `squadron.theme`. A workspace write would
   * land in the repo, and a Global one would recolour every window. No
   * folder: the Global write, which a folder with no file still reads. The
   * configuration listener echoes only that write, so a file pick refreshes
   * itself.
   *
   * Refused when the write did not land, or when this window's folder changed
   * before the push. The hold clears only when a push names the pick, so
   * either mismatch would keep that background until reload.
   */
  private async setTheme(theme: ThemeName): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      let landed = false;
      try {
        await vscode.workspace
          .getConfiguration('squadron')
          .update('theme', theme, vscode.ConfigurationTarget.Global);
        landed = vscode.workspace.getConfiguration('squadron').get('theme') === theme;
      } catch (error) {
        OverviewPanel.log(`settings: theme was not written — ${String(error)}`);
      }
      if (!landed) this.post({ type: 'themeChoice', theme, landed: false });
      return;
    }
    if (!(await writeRepoTheme(folder, theme))) {
      this.post({ type: 'themeChoice', theme, landed: false });
      return;
    }
    try {
      await this.refresh();
    } finally {
      // After the push. Refusing first paints the theme this window already
      // had, for as long as the refresh takes.
      if (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath !== folder) {
        this.post({ type: 'themeChoice', theme, landed: false });
      }
    }
  }

  /**
   * Guard each stored pid with its start time against reuse. Drop absent
   * sessions: this write also compacts dead entries from the file.
   */
  private async arrange(cwd: string, slots: number[]): Promise<void> {
    const startedAt = new Map(this.sessions.map((s) => [s.pid, s.startedAt]));
    await writeArrangement(
      cwd,
      slots.flatMap((pid) => {
        const started = startedAt.get(pid);
        return started === undefined ? [] : [{ pid, startedAt: started }];
      })
    );
    await this.refresh();
  }

  private discoveryKey(cards: readonly Session[]): string {
    return ownedDiscoveryKey(
      cards,
      cards.map(({ pid }) => ownedStamp(ownedSession(pid))?.generation)
    );
  }

  private ownedCards(): Session[] {
    return [...ownedSessions(vscode.env.sessionId), ...endingSessions()];
  }

  refresh(via: RefreshVia = 'ui'): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (via === 'watch') invalidateUsage();
    this.boardRequests.add(via);
    this.boardReading ??= this.refreshBoard();
    return this.boardReading;
  }

  private async refreshBoard(): Promise<void> {
    try {
      while (!this.disposed && this.boardRequests.size) {
        const sources = [...this.boardRequests];
        this.boardRequests.clear();
        const started = performance.now();
        try {
          await this.refreshOnce();
        } finally {
          record('refresh', performance.now() - started);
          for (const source of sources) record(`refresh:${source}`);
        }
      }
    } finally {
      this.boardReading = undefined;
    }
  }

  private refreshThread(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.threadAgain = true;
    this.threadReading ??= this.readThreads();
    return this.threadReading;
  }

  private async readThreads(): Promise<void> {
    try {
      while (this.threadAgain && !this.disposed) {
        this.threadAgain = false;
        await this.readThread();
      }
    } finally {
      this.threadReading = undefined;
    }
  }

  private async readThread(): Promise<void> {
    const selection = this.selectionRequest;
    if (!this.panel.visible || this.selected === undefined || selection === undefined) return;
    const pid = this.selected;
    const metadata = this.threadMetadata;
    const key = this.discoveryKey(this.ownedCards().filter((card) => card.pid === pid));
    if (metadata?.pid !== pid || key !== metadata.key) {
      // Board completion requests recovery; a new conversation cannot borrow
      // its workflow or model menu from the preceding cached conversation.
      return;
    }
    const epoch = this.selectionEpoch;
    const polled = ownedStamp(ownedSession(pid));
    const started = performance.now();
    const built = await buildThread(
      this,
      this.sessions,
      readWorkflowIndex().then((read) => read.runnable),
      this.fullHistory
    );
    record('threadRead', performance.now() - started);
    if (
      this.disposed ||
      !this.panel.visible ||
      epoch !== this.selectionEpoch ||
      selection !== this.selectionRequest ||
      metadata !== this.threadMetadata ||
      key !== this.discoveryKey(this.ownedCards().filter((card) => card.pid === pid))
    )
      return;
    const held = built.capture;
    if (held) {
      const current = ownedSession(pid)?.state;
      // Answer/queue changes can leave the board key unchanged. Do not revive
      // their older controls after an acknowledgement already reached the UI.
      if (
        held.live.pending !== current?.pending ||
        held.live.queued !== current.queued ||
        held.live.inFlight !== current.inFlight
      )
        return;
      if (!publishable(held, polled, ownedStamp(ownedSession(pid)), this.publishedRead)) return;
      this.publishedRead = held.order;
    }
    if (!built.thread) return;
    this.fullHistory = !!built.thread.fullHistory;
    const signature = JSON.stringify({ generation: held?.generation ?? 0, thread: built.thread });
    const now = Date.now();
    if (signature === this.lastThread && now - this.lastThreadAt < UNCHANGED_MS) return;
    const full = this.lastThread === undefined || now - this.lastThreadAt >= UNCHANGED_MS;
    this.lastThread = signature;
    this.lastThreadAt = now;
    const revision = ++this.contentRevision;
    const publication: ThreadPublication = {
      selection,
      generation: held?.generation ?? 0,
      sequence: ++this.threadSequence,
      revision
    };
    const snapshot: ThreadMessage = { type: 'thread', ...publication, thread: built.thread };
    const previous = this.syncedThread;
    let message: ThreadMessage | ThreadPatchMessage = snapshot;
    if (
      previous?.publication.selection === selection &&
      previous.publication.generation === publication.generation &&
      previous.publication.revision !== undefined &&
      !full
    ) {
      const delta = threadSync.patch(
        previous.thread,
        built.thread,
        publication,
        previous.publication.revision,
        revision
      );
      if (JSON.stringify(delta).length < JSON.stringify(snapshot).length) message = delta;
    }
    record('thread', 0, Buffer.byteLength(JSON.stringify(message)));
    this.syncedThread = { thread: built.thread, publication };
    this.post(message);
  }

  private async refreshOnce(): Promise<void> {
    const ticketEpoch = this.ticketEpoch;
    const claims = await readClaims();
    const heads: HeadPass = new Map();
    // Owned sessions come from frames, so enrich their git fields here.
    // They are fresh per pass, and a cwd outside a repo adds nothing.
    // Ending ones join here, before relocation and the fold, so a card being
    // ended keeps its group, branch and family box until its process goes.
    const polledCards = this.ownedCards();
    const ownedKey = this.discoveryKey(polledCards);
    const lifecycle = ownedLifecycleKey(polledCards);
    const selected = this.selected;
    const threadMetadata =
      selected === undefined
        ? undefined
        : {
            pid: selected,
            key: this.discoveryKey(polledCards.filter((card) => card.pid === selected))
          };
    const owned = await Promise.all(
      // Locate first so a moved session still groups under its repository.
      polledCards.map(async (session) => {
        const located = await relocate(session);
        Object.assign(located, await readCheckout(located.cwd, heads));
        return located;
      })
    );
    record('discovery');
    const discovered = await discoverAll(heads);
    // Read stated names once for the board, avoiding a stat per card per poll.
    const stated = await readStatedNames();
    // Pass no published records. Keep this restriction at the call, not
    // inside foldTwins: cli/board.ts and waits still need that input.
    // This avoids a live/ walk and relocation and checkout reads for every
    // record in every window on every poll.
    const folded = foldTwins(owned, discovered, new Map(), stated);
    // Filter before notifications, or Open could select a pid with no card.
    let sessions = onBoard(folded);
    // Overlay last-good process cwd, then read its branch. Origin checkout
    // above still controls grouping. Hidden skips the process spawn.
    if (this.panel.visible) {
      this.kickProcessCwds(sessions);
      const found = this.processCwdCache.found;
      sessions = await Promise.all(
        sessions.map((session) => withProcessCwd(session, found.get(session.pid)))
      );
    }
    await Promise.all(sessions.map((session) => withLiveBranch(session, heads)));
    await workflowTallies(sessions);
    await this.heldAcks.settle(sessions, Date.now());
    await markSeen(sessions);
    const commit = (): boolean =>
      commitOwnedBoard(lifecycle, this.ownedCards(), {
        refresh: () => {
          this.boardRequests.add('owned');
        },
        commit: () => {
          const previous = this.sessions;
          this.sessions = sessions;
          this.ownedKey = ownedKey;
          this.threadMetadata = threadMetadata;
          if (this.primed) {
            this.notifyWaiting(previous, sessions);
            this.notifySound(previous, sessions);
          }
          this.primed = true;
        }
      });
    if (!this.panel.visible) {
      commit();
      return;
    }
    this.sampleMemory();
    // Models read the starting auth state, so filtering trails changes by one
    // pass. Login refreshes directly through forceAuth.
    this.models = this.gatherModels();
    if (!this.configuredTickets) {
      const secrets = await this.ticketSecrets();
      if (ticketEpoch !== this.ticketEpoch) {
        this.boardRequests.add('ui');
        return;
      }
      const cfg = vscode.workspace.getConfiguration('squadron');
      this.configuredTickets = connections.CONNECTORS.flatMap((entry, index) => {
        const opened = connections.openConnection(entry, secrets[index], {
          endpoint: ticketEndpoint(entry),
          generation: this.ticketEpoch,
          setting: (key) => cfg.get<string>(key)
        });
        return opened ? [opened] : [];
      });
    }
    const ticketState = this.tickets.state({
      generation: this.ticketEpoch,
      sources: this.configuredTickets ?? []
    });
    const ticketSource = ticketState.status && {
      ...ticketState.status,
      ...(this.ticketConnecting && { connecting: this.ticketConnecting })
    };
    // Resolve the folder's repo too: a worktree window groups under its repo.
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const folderRoots = await repoRoots([
      ...claims.flatMap((claim) => (claim.folder ? [claim.folder] : [])),
      ...(folder ? [folder] : [])
    ]);
    const scratchRoot = await scratch.scratchRoot();
    // Share one index read between the bottom hub, selected strip and edits.
    const indexRead = readWorkflowIndex();
    // Gate the reads too: disabled chips need no worktree, port or process walks.
    const wanted = this.flag('devServers.enabled');
    const [arrangements, index, workflowOrder, servers] = await Promise.all([
      readArrangements(),
      indexRead,
      readWorkflowOrder(),
      wanted ? serverContext(this, sessions, claims, folder, folderRoots, scratchRoot) : undefined
    ]);
    // Re-read the gate after gathering: lsof can outlive a switch-off refresh
    // and otherwise put its old chips and switch state back.
    const devServers = this.flag('devServers.enabled');
    await refreshAuthIfDue(this);
    const usageBy = await refreshUsage(this);
    // Same tick as auth, and file reads only — `claude mcp list` would cost a
    // network round trip per server behind a popover nobody may open. Roots are
    // the repos with a card plus this window's folders: `mcpServers` is keyed by
    // the directory the CLI ran in, and nothing else on the machine is on screen.
    //
    // **Repo roots as well as cwds, because of worktrees.** `claude mcp add` run
    // inside a worktree reports the worktree's path and writes the entry under
    // the *main* checkout's — observed 2026-08-11. A board of worktree sessions
    // would otherwise show no servers at all. `repoRoot` is already the main
    // checkout for a worktree (`core/model.ts`), so both go in.
    //
    // **Which repo each of those is, as well as where to read.** The sheet is
    // cut into one section per repo, and three worktrees of one repo are one
    // section — a join only the poll can make, since it is the half that has
    // already asked git.
    //
    // **This window's folder goes in by hand.** `repoRoots` is worktrees-only
    // by design (`core/git.ts`) — every directory inside a repo has a root
    // above it, and folding on that would collapse groups that have nothing to
    // do with worktrees. So a window open on an ordinary checkout is in neither
    // half of that map, and without this line its own repo has no section, no
    // `here`, and the sheet opens with everything shut.
    const ownRoot = folder ? (folderRoots.get(folder) ?? folder) : undefined;
    const repoOf: Record<string, string> = {};
    for (const [dir, root] of folderRoots) repoOf[dir] = root;
    if (folder && ownRoot) repoOf[folder] = ownRoot;
    if (!folder) repoOf[scratchRoot] = scratchRoot;
    for (const s of sessions) {
      // Do not overwrite a good folderRoots mapping with an absent repoRoot.
      if (groupKey(s, scratchRoot) === scratchRoot) repoOf[s.cwd] = scratchRoot;
      else if (s.repoRoot) repoOf[s.cwd] = s.repoRoot;
      else repoOf[s.cwd] ??= s.cwd;
    }
    await refreshMcpIfDue(this, {
      roots: [
        ...new Set([
          ...folderRoots.keys(),
          ...folderRoots.values(),
          folder ?? scratchRoot,
          ...sessions.flatMap((s) => (s.repoRoot ? [s.cwd, s.repoRoot] : [s.cwd]))
        ])
      ],
      repoOf,
      repos: [...new Set(Object.values(repoOf))].map((root) => ({
        root,
        label: path.basename(root),
        path: shorten(root)
      })),
      ...(ownRoot ? { ownRoot } : {})
    });
    // Sample after awaits so the CPU window excludes this pass's read time.
    this.cpu = meter(this.cpu, cpuSample());
    const accounts = accountsView(this, sessions, usageBy);
    const onboardingDone = OverviewPanel.globalMemory?.get<boolean>(ONBOARDING_KEY, false) ?? true;
    const message = buildState({
      sessions,
      workspaceFolder: folder,
      scratchRoot,
      folderRoots,
      arrangements,
      accounts,
      ...(accounts ? {} : { usageWindows: waitingUsageWindows() }),
      onboardingDone,
      skillInstall: await skillInstallView(),
      mcp: mcpForWire(this),
      machine: machineView(this.cpu.cpu, this.memory),
      ...(await this.cafe()),
      remote: await this.remoteState(),
      cafe: this.flag('cafe.enabled', true),
      cafeRemote: this.flag('cafe.remote', true),
      cafeWarm: this.flag('cafe.warm', true),
      warmOn: warm.warmOn(ownedSessions(vscode.env.sessionId)).length > 0,
      orchestrators: this.flag('orchestrators.enabled'),
      skipPermissions: this.flag('skipPermissions.enabled'),
      executionCapture: this.flag('checkpoints.execution.enabled'),
      soundLevel: this.soundLevel(),
      devServers,
      mascot: this.flag('mascot.enabled'),
      warmCache: this.flag('warmCache.enabled'),
      warmPolicy: readWarmPolicy(),
      theme: await this.themeName(),
      model: this.modelSetting(),
      contextWindow: this.windowSetting(),
      efforts: this.effortsSetting(),
      models: this.models,
      tickets: ticketState.tickets,
      ticketSource,
      workflows: index.runnable,
      workflowEdits: index.edits,
      workflowOrder,
      servers: devServers ? servers : undefined,
      skills: await skills.skillsByDirectory([
        ...sessions.map((session) => groupKey(session, scratchRoot)),
        ...(folder ? [folder] : []),
        folder ? (folderRoots.get(folder) ?? folder) : scratchRoot,
        ...(devServers && servers ? servers.trees.keys() : [])
      ]),
      editorSkills: skills.allSkills(),
      now: Date.now()
    });
    if (this.disposed) return;
    if (ticketEpoch !== this.ticketEpoch) {
      this.boardRequests.add('ui');
      return;
    }
    if (!commit()) return;
    this.postState(message);
    void this.refreshThread();
  }

  /**
   * The coffee, as the cup needs it — and where the reader put the cup.
   *
   * Read here rather than pushed by the keeper: `host/keepawake.ts` runs on its
   * own clock with no panel to talk to, and the records are on disk exactly so
   * that any window's panel can draw the machine's state without asking the
   * window that holds it. One `readJsonDir` over a directory with at most one
   * file per IDE window.
   *
   * **The cup animates off the webview's 1s beat, not this poll.** What goes on
   * the wire is `until` and the lease it is a share of, both of which move once
   * every ten minutes; the level between them is divided out in
   * `webview/cafe.ts`. It used to be divided here against a moving `now`, which
   * made every state message differ from the last one by construction — see
   * `docs/tasks/TASK_done_panel_repaint_cost.md`.
   *
   * Absent `awake` takes the cup away, which is what the flag being off and an
   * OS that cannot take the lock both mean. The reason vocabulary never carries
   * those two to the panel — there is nothing for a cup to say when there is no
   * cup.
   */
  private async cafe(): Promise<{ awake?: AwakeView; cafeAt?: { x: number; y: number } }> {
    if (!this.flag('cafe.enabled', true) || !platform.power.holds.supported) {
      return {};
    }
    const now = Date.now();
    const holds = await readHolds(now);
    return { awake: cafeView(holds, now), ...this.cafeAt() };
  }

  /** Narrow workspace storage before sending: it can hold a stale or edited shape. */
  private cafeAt(): { cafeAt?: { x: number; y: number } } {
    const stored = OverviewPanel.memory?.get(CAFE_KEY);
    if (!stored || typeof stored !== 'object') {
      return {};
    }
    const at = stored as Partial<{ x: number; y: number }>;
    if (typeof at.x !== 'number' || typeof at.y !== 'number') {
      return {};
    }
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) {
      return {};
    }
    return { cafeAt: { x: at.x, y: at.y } };
  }

  private kickProcessCwds(sessions: readonly Session[]): void {
    const cache = this.processCwdCache;
    // Mark in-flight before spawning, or a hung lsof could start another (runs.ts).
    if (cache.inflight) {
      return;
    }
    const pids = sessions.map((session) => session.pid);
    if (pids.length === 0) {
      return;
    }
    cache.inflight = true;
    void processCwds(pids)
      .then((found) => {
        if (this.disposed) return;
        // Empty is killed / no `lsof` / every pid unread — keep last-good.
        if (found.size > 0) {
          cache.found = found;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        cache.inflight = false;
      });
  }

  /**
   * Do not await the memory spawn: it would enter the CPU measurement window.
   * Post the last settled answer instead. See MEMORY_MS for the time limit.
   * Stamp before reading to prevent overlapping slow reads. A failed reading
   * becomes null, distinct from the undefined of an unread value.
   */
  private sampleMemory(): void {
    const now = Date.now();
    if (now - this.memoryAt < MEMORY_MS) return;
    this.memoryAt = now;
    void readMemory().then((reading) => {
      if (this.disposed) return;
      this.memory = reading ?? null;
    });
  }

  /**
   * Every source's keychain record, read once per `ticketEpoch` rather than on
   * every poll: `configuredTickets` holds what they opened until `resetTickets`
   * drops it.
   *
   * It used to be `await secrets.get(...)` inside `refresh()`, which is 33 reads
   * a minute of a keychain for a string that changes when somebody connects or
   * disconnects (`TASK_done_panel_repaint_cost.md`, Step 8). The post
   * dedupe does not touch it: that skips the *push*, and this happens well
   * before the message is built.
   *
   * **The cache is the easy half; noticing is the point.** Reading per poll also
   * meant a key connected in *another* window was picked up here within 3 s, and
   * a plain cache would have quietly ended that. `secrets.onDidChange` is what
   * keeps the other window; this window's own connect goes through
   * `resetTickets`. A reset landing mid-read reads again, so a record from
   * before it never opens a source under the new epoch.
   */
  private async ticketSecrets(): Promise<(string | undefined)[]> {
    const secrets = OverviewPanel.secrets;
    if (!secrets) return connections.CONNECTORS.map(() => undefined);
    const epoch = this.ticketEpoch;
    const records = await Promise.all(
      connections.CONNECTORS.map((entry) => secrets.get(entry.secretKey))
    );
    return epoch === this.ticketEpoch ? records : this.ticketSecrets();
  }

  /**
   * (Re)start the poll at the rate this panel's visibility deserves.
   *
   * One timer, replaced rather than gated inside the callback, so a hidden panel
   * is not waking the extension host twenty times a minute to decide it has
   * nothing to do.
   */
  private pace(): void {
    const every = this.panel.visible ? POLL_MS : HIDDEN_POLL_MS;
    if (this.polling === every) {
      return;
    }
    clearInterval(this.poll);
    this.polling = every;
    this.poll = setInterval(() => void this.refresh('poll'), every);
  }

  /** Drop everything and start over — the key or the query itself changed. */
  private resetTickets(): void {
    this.ticketEpoch++;
    // Dropping the sources drops the records they opened from. A connect stores
    // then calls this in the same turn; onDidChange is for other windows and is
    // not guaranteed to have fired before the refresh below reads the keychain.
    // The smoke host's in-memory secret store made that visible: the next click
    // still saw unlinked and opened another input instead of the dock.
    this.configuredTickets = undefined;
    this.tickets.reset();
    void this.refresh();
  }

  post(message: PanelMessage): void {
    // Both publication paths weigh their existing dedupe serialization; do not
    // serialize direct replies a second time merely to count this transport.
    record('post');
    void this.panel.webview.postMessage(message);
  }

  /** Machine values vary every poll; only their availability affects dedupe. */
  private postState(message: StateMessage): void {
    const key = stateKey(message);
    const now = Date.now();
    if (key === this.lastState && now - this.lastPostAt < UNCHANGED_MS) {
      record('skipped');
      return;
    }
    this.lastState = key;
    this.lastPostAt = now;
    // UTF-8 bytes, including non-ASCII names. Machine values are excluded from
    // the key; this counter weighs the board, while `thread` weighs the dock.
    record('state', 0, Buffer.byteLength(key));
    this.post(message);
  }

  /**
   * Toast each session that just went `waiting`, so a block reaches someone not
   * looking at the panel. Every waiting session, every window — the simplest
   * rule, at the cost of a duplicate toast when a second Squadron window is
   * open. "Open" reveals this panel and selects the session.
   *
   * The one notification the panel keeps, and deliberately: everything else it
   * had to say confirmed something the reader was already looking at, and went
   * to the status bar. This says the opposite — the reader is not looking, and
   * that is the whole message. Nothing else carries it out of the panel: the
   * card's `waiting` paint needs the tab visible, the status bar is a line
   * nobody watches, and `notifySound` is silent with the panel
   * closed. "Open" is the other half — a status-bar line cannot be
   * clicked to the session it names.
   */
  private notifyWaiting(previous: Session[], sessions: Session[]): void {
    for (const session of newlyWaiting(previous, sessions)) {
      const name = displayName(session);
      const label = session.waitingFor ? `${name} — ${session.waitingFor}` : name;
      void vscode.window.showInformationMessage(label, 'Open').then((choice) => {
        const current = this.sessions.find(({ pid }) => pid === session.pid);
        if (choice === 'Open' && current && sameSessionStart(current.startedAt, session.startedAt))
          revealSession(this, session.pid, session.startedAt);
      });
    }
  }

  /**
   * Send cues separately from state so a repaint cannot repeat the cue.
   * Gate sound here so off means no cue is sent.
   */
  private notifySound(previous: Session[], sessions: Session[]): void {
    if (this.soundLevel() === 'off') return;
    const cue = soundCue(previous, sessions);
    if (cue) this.post({ type: 'sound', cue });
  }

  /**
   * Card clicks and deliberate dock input both acknowledge, not only done cards:
   * work finishing later remains new. Core completion decides what the mark retires.
   * Write before repaint so the click and status share a paint. Mark the
   * departed card too. Hold an opened pid with no session id in HeldAcks.
   */
  private async opened(pid: number, left?: number): Promise<void> {
    const idOf = (of: number): string | undefined =>
      of ? this.sessions.find((s) => s.pid === of)?.sessionId : undefined;
    if (pid && !idOf(pid)) this.heldAcks.hold(pid, Date.now());
    await Promise.all(
      [idOf(pid), left === pid ? undefined : idOf(left ?? 0)]
        .filter((id): id is string => !!id)
        .map((id) => writeAck(id))
    );
    await this.refresh();
  }

  private dispose(): void {
    this.disposed = true;
    this.conversationReader.dispose();
    this.conversationSnapshots.dispose();
    this.tickets.dispose();
    this.configuredTickets = undefined;
    this.confirmations.dispose();
    cancelLogin(this);
    // Not optional the way the line above nearly is: an MCP login left running
    // holds a pty and a bound callback port for as long as the machine is up.
    cancelMcpLogin(this);
    OverviewPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.panel.dispose();
  }
}
