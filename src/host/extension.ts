import { accountUsage } from './usage';
import type { UsageRefresher } from '../core/usage_refresh';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { adapter } from '../core/adapter';
import { BRANDS } from '../core/brands';
import { endExecutionRuntime } from '../core/checkpoint';
import { uninstallHooks } from '../core/claude/hooks';
import { pruneReports } from '../core/coordination/reports';
import { claimRequests } from '../core/coordination/requests';
import { pruneWaits } from '../core/coordination/wait';
import { removeServer } from '../core/devservers/servers';
import { orphanedRuntimes } from '../core/execution';
import { prunePastes } from '../core/pastes';
import {
  BIN_DIR,
  SHIM_NAMES,
  NEVER_SENT_DIRS,
  WORKFLOW_VALIDATION_SHIM,
  ensureHome
} from '../core/paths';
import { report as perfReport, reset as resetPerf } from '../core/perf';
import * as platform from '../core/platform';
import type { Lease } from '../core/platform/processes';
import { pruneStatus } from '../core/prune';
import { SHUTDOWN_BUDGET, drain, settleThenRelease, startAfter } from '../core/shutdown';
import * as reconcile from '../core/reconcile';
import { AttachGuard } from '../core/remote/attach';
import { unclaimAfter } from '../core/remote/holder';
import { type AttachPort } from '../core/remote/serve_attach';
import * as skillInstall from '../core/skill_install';
import { setUsageLog } from '../core/usage';
import * as examples from '../core/workflows/examples';
import { registerBeforeImages } from './diff';
import { KeepAwake } from './keepawake';
import { OverviewPanel } from './panel';
import { RemoteHost } from './remote';
import * as requestHost from './request_host';
import { touchHeldServers } from './runs';
import {
  activateIncomingOwner,
  closeAll,
  onOwnedChange,
  republishAllWarm,
  setExecutionEnabled,
  setOwnedLog
} from './sessions';
import * as skills from './skills';
import { heldServers, watchServerTerminals } from './terminal';
import { WaitResolver } from './waits';
import { cacheWarmer } from './warm';
import { onSessionState } from './watch';
import { WindowClaimant } from './windows';

/** Brisk, because a click in another window is waiting on this poll. */
const REQUEST_POLL_MS = 500;

/**
 * Stay within SERVER_STALE_MS (90s), allowing two missed ticks on a busy machine.
 * Run independently of the panel, whose poll stops when its tab is covered.
 */
const SERVER_HEARTBEAT_MS = 20_000;

/**
 * Unhurried, because the youngest thing either sweep removes is a day old.
 * Every open window runs its own; they remove the same files and race harmlessly.
 */
const PRUNE_POLL_MS = 6 * 60 * 60 * 1000;

/**
 * Where an agent-initiated spawn is announced. `serve` runs with no panel open
 * and a spawn from here shows nothing anywhere, so without this a fan-out is
 * five CLI processes appearing with nothing saying who asked for them.
 */
let output: vscode.OutputChannel | undefined;

/** Remote in this window, panel-free like the keeper: `deactivate` awaits its
 *  dispose so the holder file goes before the host does (D37). */
let remote: RemoteHost | undefined;

/** This window's claim. Not a subscription: the host disposes those without
 *  awaiting `deactivate`, and the claim must outlive Remote's dispose
 *  (`unclaimAfter`). */
let claimant: WindowClaimant | undefined;

/** `attach`'s effects over `remote`, built in `activate`, where the host's
 *  user-data directory is known. */
let attaching: AttachPort | undefined;
let requestOwner: requestHost.RequestHost | undefined;
let usageRefresher: UsageRefresher | undefined;

/** This window's hold on a reusable process reader, from before its first
 *  identity read until owned shutdown has finished reading. A host that dies
 *  without `deactivate` closes the reader's stdin, and it exits on that EOF. */
let processReader: Lease | undefined;

function log(line: string): void {
  try {
    output?.appendLine(`${new Date().toISOString()} ${line}`);
  } catch {
    // Stock VS Code closes the output channel before calling deactivate.
  }
}

/** The agent-facing commands, by the name they are run under. The list lives in
 *  `core/paths.ts`, where a test with no `vscode` can compare it against the
 *  skill that documents them. */
const SHIMS = [...SHIM_NAMES, WORKFLOW_VALIDATION_SHIM];

/**
 * Puts the agent shims somewhere an agent can actually run them.
 *
 * The extension directory is version-stamped, so a path documented today is
 * wrong after the next release, and nothing puts `bin/` on `PATH` — the hooks
 * only work because their absolute path is written into `settings.json` each
 * time. Same trick, one level out: the bundles are copied to a stable place.
 *
 * What is copied is `dist/squadron-*.js`, each carrying `core/` inside it.
 * The spawn one used to be a thin script plus a `paths.json` naming this
 * version's compiled tree, and that broke silently the day the emit moved from
 * `out/` to `dist/`: every agent spawn exited "no window" while the panel
 * worked. A self-contained bundle has nothing to go stale.
 *
 * Rewritten on every activation, so an upgrade repairs it rather than leaving a
 * shim pointing into a directory that is gone. Each is copied on its own —
 * `stop` arriving in a build that predates it must not stop `spawn` landing.
 * Installation is `platform.launchers`; this loop only chooses the
 * directory, the names and the bundle.
 */
async function installShim(extensionPath: string): Promise<void> {
  for (const name of SHIMS) {
    await platform.launchers.install(BIN_DIR, name, path.join(extensionPath, 'dist', `${name}.js`));
  }
  await platform.launchers.installHelperLocator(BIN_DIR, extensionPath);
}

/**
 * Puts the bundled skills where a session can load them, when the verbs they document
 * are switched on — in every brand's own skill root, since a verb is callable
 * from any brand's session. A brand whose directory is absent is not installed
 * here and gets nothing; `CliAdapter.skillRoot` says why each root is its own.
 *
 * Install-or-leave, never delete. This flag is per **IDE install**, not per
 * machine, and defaults to false — so an uninstall here would mean the window
 * where it was never set removing the file the window where it was set just
 * wrote, at every launch. A skill sitting on disk while the flag is off
 * describes verbs that refuse with a reason, which is idle rather than wrong.
 *
 * The outcome is logged and never shown: activation runs whether or not a panel
 * is open, and `showWarningMessage` is what H27 spent a row removing. What the
 * line is for is the one terminal outcome — a file we may not overwrite stays
 * that way until a human looks at it.
 */
async function reconcileSkill(extensionPath: string, version: string): Promise<void> {
  if (!vscode.workspace.getConfiguration('squadron').get<boolean>('orchestrators.enabled', false))
    return;
  const source = path.join(extensionPath, 'install', 'skills');
  for (const brand of BRANDS) {
    const root = adapter(brand)?.skillRoot(os.homedir(), process.env);
    if (root === undefined) continue;
    const results = await skillInstall.installBundledSkills(
      source,
      version,
      ...skillInstall.skillTarget(root)
    );
    for (const { file, outcome } of results) {
      // `current` is the steady state and says nothing; the rest each name what a
      // reader would have to know to act. Two of them are terminal until a human
      // intervenes, so they say where the file is and what to do with it.
      if (outcome === 'current') continue;
      log(
        {
          written: `skill install: wrote ${file} at ${version}`,
          'left-foreign': `skill install: ${file} was not written by this extension, or has been edited — left alone. Delete it to take the shipped one.`,
          'left-newer': `skill install: ${file} carries a newer build's stamp than ${version} — left alone. After a rollback, delete it to drop back to this version's.`,
          'left-tie': `skill install: another install of ${version} owns ${file} — left alone.`,
          'no-cli-dir': `skill install: no ${root} on this machine, nothing written for ${brand}`,
          'unsafe-path': `skill install: ${file} does not resolve inside ${root} — a symlink somewhere above it — so nothing was written.`,
          failed: `skill install: could not write ${file}`
        }[outcome]
      );
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Before `activateIncomingOwner`, whose host identity is the first read.
  processReader = platform.processes.own();
  const requestsHost = requestHost.createRequestHost({
    getRemote: () => remote,
    getAttaching: () => attaching,
    log
  });
  requestOwner = requestsHost;
  activateIncomingOwner();
  // The store tree, before any writer or watcher. Writers still mkdir on
  // demand; this is so a stranger has a path to look at (roadmap 61).
  await ensureHome();
  // The Linear key lives in the OS keychain, reached through the panel.
  OverviewPanel.secrets = context.secrets;
  // Panel state that outlives the window, kept per workspace so two IDE windows
  // on two projects keep their own.
  OverviewPanel.memory = context.workspaceState;
  OverviewPanel.globalMemory = context.globalState;
  // The installed build, which only the host can see. The settings menu shows
  // it, so a bug report can name the version it came from.
  OverviewPanel.version = context.extension.packageJSON.version ?? '';
  OverviewPanel.title = context.extension.packageJSON.displayName ?? OverviewPanel.title;
  // Where media/ is on this install, so the tab can wear the same icon the
  // Extensions list does.
  OverviewPanel.extensionUri = context.extensionUri;

  output = vscode.window.createOutputChannel('Squadron');
  setOwnedLog(log);
  setUsageLog(log);
  for (const line of await examples.seedExamples(
    path.join(context.extensionPath, 'install', 'workflows')
  )) {
    log(line);
  }

  // Published even when the panel is closed: the shims and other windows pick a
  // window to ask off this claim.
  claimant = new WindowClaimant();
  claimant.start();

  // Repeat the sweep: a long-lived IDE window would otherwise let stores grow
  // after its one activation-time cleanup.
  const sweep = () => {
    void prunePastes();
    void pruneStatus();
    void remote?.housekeep().catch((error: unknown) => log(`remote cleanup: ${String(error)}`));
    // A wait whose host died between registration and convergence: its
    // requester went with that host, so no window will ever own the pid and no
    // pass will pick the record up. `core/coordination/wait.ts` has the age and why.
    void pruneWaits();
    // A report's whole life is bounded by `WAIT_TTL_MS`, so a day-old one is a
    // report no window was left to deliver or release. Swept beside the waits
    // it rides, since neither outlives the other by design.
    void pruneReports();
    // A runtime whose host died left its active rows unbounded, which withholds
    // every neighbour's inferred pills on those trees until something ends it.
    void orphanedRuntimes()
      .then(async (orphans) => {
        for (const { runtime, contextFile } of orphans) {
          await endExecutionRuntime(runtime, contextFile);
        }
      })
      .catch(() => undefined);
  };
  sweep();
  const sweeping = setInterval(sweep, PRUNE_POLL_MS);

  // Likewise watched even when the panel is closed: a `squadron-*` shim can ask
  // this window to start, send to, rename or close a session it drives, and only
  // this one can.
  const requests = setInterval(
    () => void claimRequests(vscode.env.sessionId, requestsHost.serve),
    REQUEST_POLL_MS
  );

  // Keep held servers alive independently of panel visibility; see SERVER_HEARTBEAT_MS.
  const beating = setInterval(() => void touchHeldServers(), SERVER_HEARTBEAT_MS);

  // Held even when the panel is closed, for the same reason as both of the
  // above: a machine that sleeps mid-run stalls the session whether or not
  // anybody is looking at the board. Nothing polls — the keeper is woken by its
  // registration's refill deadline and by any owned session changing state.
  // It does nothing while there is neither coffee nor activity.
  const reconciliation = new reconcile.Reconciler(log);
  const keeper = new KeepAwake(reconciliation, () => remote?.holds() === true, log);
  // Keep the existing startup request for behavior parity. Activation starts
  // with an empty owned registry and reload closes its old pipes; useful checks
  // follow later owned frames, so this is not recovery of surviving sessions.
  keeper.registration.requestCheck();

  // The registered waits — panel-free for the keeper's reason, and woken the
  // same way it is. `host/waits.ts` has the whole of it.
  const waiter = new WaitResolver(reconciliation, log);
  const warmer = cacheWarmer(reconciliation, log);
  const usage = accountUsage(reconciliation, log);
  usageRefresher = usage;
  usage.registration.requestCheck();
  const stopUsageOwned = onOwnedChange(() => usage.observations.noticeChange());
  const stopUsageDisk = onSessionState((change) => {
    if (change === 'watch') usage.registration.noticeChange();
  });
  // Panel-free for the keeper's reason: Remote answers the phone with every
  // panel closed. A reload within two minutes turns it back on here.
  const host = new RemoteHost(
    context,
    reconciliation,
    keeper,
    requestsHost.startRemote,
    requestsHost.remoteModels,
    log,
    requestsHost.startFiles
  );
  remote = host;
  OverviewPanel.remote = host;
  OverviewPanel.log = log;
  attaching = {
    holds: () => host.holds(),
    target: (addr) => host.attachTarget(addr),
    attach: (addr, attachment) => host.attach(addr, attachment),
    // `globalStorageUri` is `<user data>/User/globalStorage/<extension>`, and
    // `SecretStorage`'s encrypted store is under the same user-data directory.
    deny: [...NEVER_SENT_DIRS, path.resolve(context.globalStorageUri.fsPath, '..', '..', '..')],
    guard: new AttachGuard()
  };
  void host.restore();
  const stopWarmChanges = onOwnedChange(() => warmer.registration.noticeChange());
  // React to every owned change, not just busy edges: filtering here would
  // duplicate Café's working-session rule in core/awake.ts.
  const stopCafeChanges = onOwnedChange(() => keeper.registration.noticeChange());
  // Both channels are required — host/waits.ts's module doc says why.
  const stopOwnedWaitChanges = onOwnedChange(() => waiter.registration.noticeChange());
  const stopDiskWaitChanges = onSessionState(() => waiter.registration.noticeChange());

  // Every hook an earlier build installed. A settings file we could not read or
  // write is the user's to fix; the hook it may still hold fails on its own.
  void uninstallHooks().catch(() => undefined);
  void installShim(context.extensionPath);
  context.subscriptions.push(
    skills.startSkillDiscovery(
      reconcileSkill(context.extensionPath, OverviewPanel.version),
      () => OverviewPanel.refreshOpen(),
      log
    )
  );

  context.subscriptions.push(
    output,
    // What a file was at HEAD, for the diff a turn's counts open. Registered at
    // activation rather than with the panel: a diff tab outlives the panel that
    // opened it, and asking a closed panel for content would answer nothing.
    registerBeforeImages(),
    // A dev server killed by closing its tab is a dev server stopped, and the
    // registry hears it here rather than waiting out the staleness horizon.
    watchServerTerminals((cwd, runnerId) => void removeServer(cwd, runnerId)),
    {
      dispose: () => {
        stopUsageOwned();
        stopUsageDisk();
        void usage.dispose();
        stopWarmChanges();
        stopCafeChanges();
        stopOwnedWaitChanges();
        stopDiskWaitChanges();
        warmer.dispose();
        keeper.dispose();
        waiter.dispose();
        // Backstop: participants already unregister their own checks.
        reconciliation.dispose();
      }
    },
    { dispose: () => clearInterval(requests) },
    { dispose: () => clearInterval(sweeping) },
    { dispose: () => clearInterval(beating) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('squadron.checkpoints.execution.enabled')) {
        void setExecutionEnabled(
          vscode.workspace
            .getConfiguration('squadron')
            .get<boolean>('checkpoints.execution.enabled', false)
        );
      }
      if (e.affectsConfiguration('squadron.orchestrators.enabled')) {
        void reconcileSkill(context.extensionPath, OverviewPanel.version);
        // A heartbeat already writing may land after this one and keep the old
        // value until the next beat (30 s); accepted.
        void claimant?.publish();
      }
      if (e.affectsConfiguration('squadron.warmCache')) {
        republishAllWarm(e.affectsConfiguration('squadron.warmCache.enabled'));
        warmer.policyChanged();
      }
      // Turning the café off must release the machine now, not when the current
      // coffee runs out; turning it on must hold without waiting for a session
      // to change state. The Remote and Warm holds the same, for a lease poured
      // for either.
      if (
        e.affectsConfiguration('squadron.cafe.enabled') ||
        e.affectsConfiguration('squadron.cafe.remote') ||
        e.affectsConfiguration('squadron.cafe.warm')
      ) {
        keeper.registration.requestCheck();
      }
    }),
    vscode.commands.registerCommand('squadron.showOverview', () => OverviewPanel.show()),
    vscode.commands.registerCommand('squadron.remote.turnOn', () => host.turnOn()),
    vscode.commands.registerCommand('squadron.remote.turnOff', () => host.turnOff()),
    vscode.commands.registerCommand('squadron.remote.connect', () => host.connect()),
    vscode.commands.registerCommand('squadron.remote.disconnect', () => host.disconnect()),
    vscode.commands.registerCommand('squadron.connectLinear', () => OverviewPanel.connectLinear()),
    vscode.commands.registerCommand('squadron.disconnectLinear', () =>
      OverviewPanel.disconnectLinear()
    ),
    // Reading resets, so a reading is always "since the last one" — take one to
    // start the window and another a minute later to read it. The channel is
    // shown rather than only written to: this is asked for by hand or not at
    // all, so there is nobody to disturb by answering where they can see it.
    vscode.commands.registerCommand('squadron.logPerf', () => {
      // Written raw rather than through `log`, which stamps every line: the
      // report is already several lines with a window in its head, and a
      // timestamp down the left of a table only makes it harder to compare two.
      output?.appendLine(perfReport());
      resetPerf();
      output?.show(true);
    })
  );
}

/**
 * The tidy ending, and not the guarantee. A stream-json session dies with its
 * stdin, so the pipe closing when this process goes is what really ends the
 * children — including on the paths where this function never runs at all.
 *
 * Returns the promise rather than dropping it: the host waits on what this
 * hands back, and the removal of each session's published record is a file
 * operation that would otherwise be racing the process exit. The children need
 * no such wait — they die with the pipes either way.
 */
export function deactivate(): Promise<void> {
  // First, so the engine stops before the sessions it watches are closed, and
  // the holder is released before the host goes; the claim after that.
  const remoteOff = unclaimAfter(remote?.dispose() ?? Promise.resolve(), () => claimant?.dispose());
  // The servers go with the window: their terminals die with the host, so a
  // record left behind would hold a port in every other window's picker until
  // it went stale.
  const servers = Promise.all(
    heldServers().map(({ cwd, runnerId }) => removeServer(cwd, runnerId))
  );
  // Held reports are **not** released here, and the attempt was measured rather
  // than reasoned about. `noteHeldReports` only says what is being left.
  const notes = requestOwner?.noteHeldReports() ?? Promise.resolve();
  // After the note, which reads which sessions are still ours, but not behind
  // it: a stalled read must not keep owned shutdown from starting.
  const afterNotes = (next: () => Promise<unknown>) =>
    startAfter(notes, SHUTDOWN_BUDGET.notesMs, next);
  // The readers of process evidence settle before the reader goes: closing
  // sessions reads the table to confirm their trees are gone, and an
  // unrelated rejection (usage's last ingest) must not cut that short. Only
  // the budget does, and what had not settled by then is named in the log.
  // `closeAll` itself waits at most 1.5 s for its writes and lifetimes,
  // shorter than a lifetime's escalation, so its return is not proof every
  // descendant has ended: the lifetimes' reconciliations, which go on reading
  // the table, are the reader's own participant (`cleanup`), named one by
  // one if the budget ends first.
  const cleanup = drain('owned session cleanup');
  return settleThenRelease(
    [
      { name: 'held report note', done: notes },
      { name: 'Remote teardown', done: remoteOff, reader: true },
      { name: 'server records', done: servers },
      {
        name: 'console login',
        done: platform.consoleLogin.dispose().then((result) => {
          if (result.unresolved.length)
            throw new Error(
              `Console login shutdown unresolved: ${JSON.stringify(result.unresolved)}`
            );
        })
      },
      {
        name: 'owned sessions',
        done: afterNotes(() => closeAll((consumers) => cleanup.start(consumers)))
      },
      cleanup.participant,
      {
        name: 'usage refresh',
        done: afterNotes(() => usageRefresher?.dispose() ?? Promise.resolve()),
        reader: true
      }
    ],
    releasePlatformResources
  ).catch((error: unknown) => {
    log(`shutdown: ${String(error instanceof AggregateError ? error.errors.join('; ') : error)}`);
    throw error;
  });
}

async function releasePlatformResources() {
  // Remote's drained renewal rollback still needs private creation.
  const [files, reader] = await Promise.allSettled([
    platform.privateFiles.dispose(),
    processReader?.dispose() ?? Promise.resolve(undefined)
  ]);
  const errors = [files, reader].flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : []
  );
  if (errors.length) throw new AggregateError(errors, 'platform resource shutdown failed');
  return reader.status === 'fulfilled' ? reader.value : undefined;
}
