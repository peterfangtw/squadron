/**
 * Remote in a real extension host: `RemoteSwitch` (`core/remote/switch.ts`)
 * over `vscode`. Only what needs `vscode` lives here — `SecretStorage` and its
 * input box, settings, the extension's workspace storage, the Reconciler
 * registration and the change subscriptions. The switch's order, the pass and
 * every rule they apply are in `core/remote/` and `core/bridge/`, as
 * `host/keepawake.ts` keeps its rules in `core/awake.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Started } from '../core/bridge/bridge';
import { admitAccounts, normalizeAllowlist } from '../core/bridge/allow';
import { fakeMessenger } from '../core/bridge/fake';
import { readHolder, incomingHolderNow } from '../core/remote/holder';
import type { Holder } from '../core/remote/holder';
import type { Attached, Attachment, SessionAddr } from '../core/bridge/model';
import type { Credentials, MessengerEntry, MessengerSetup } from '../core/bridge/port';
import { readClaims } from '../core/coordination/claims';
import { readLineage } from '../core/coordination/lineage';
import type { RemoteStart } from '../core/coordination/serve_owned';
import { readPublished } from '../core/published';
import * as reconcile from '../core/reconcile';
import type { Target } from '../core/remote/board';
import { CheckRunner } from '../core/remote/check';
import { checkedFake, driveFake } from '../core/remote/fake_files';
import * as link from '../core/remote/link';
import type { RemoteView } from '../core/remote/link';
import { RemoteSwitch, type Built, type MemoryPort } from '../core/remote/switch';
import { scanProcesses } from '../core/scan';
import type { KeepAwake } from './keepawake';
import {
  endSession,
  isEnding,
  onOwnedChange,
  ownedSession,
  ownedSessions,
  ownedHostIdentity,
  ownedIncomingSnapshot,
  ownedIncomingEvidence,
  deliverIncoming
} from './sessions';
import { onSessionState } from './watch';

/**
 * How long session changes are gathered before one pass (a duration). Below
 * anything a person away from the desk notices, and it bounds the pass — one
 * `ps` included — to once per 5 s while sessions stream. The waits' window is
 * 15 s on the same reasoning.
 */
const REMOTE_CHANGE_MS = 5_000;

/**
 * Whether Remote was on in this workspace's window, and when that window went:
 * a file in the extension's storage for the workspace, which outlives a
 * reload and is this workspace's alone.
 *
 * Not `workspaceState`, measured on VS Code 1.141.0: on a reload or a close
 * the extension host exits about 12 ms after the renderer's terminate
 * message, and a `workspaceState.update` made in `deactivate` rejects with
 * `Canceled` because the renderer has already gone. Every write is to disk,
 * synchronously (`MemoryPort.write`).
 */
const MEMORY_FILE = 'remote.json';

/** The start a phone job makes here, resolved to its brand by the caller. */
export type StartHere = (start: RemoteStart) => Promise<Started>;

export class RemoteHost implements vscode.Disposable {
  private readonly remote: RemoteSwitch;
  private readonly checks: CheckRunner;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly unsubscribe: (() => void)[] = [];

  /** Fires when anything `view()` answers has moved. */
  readonly onDidChangeView = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    runtime: reconcile.Reconciler,
    keeper: KeepAwake,
    startHere: StartHere,
    modelsHere: () => Promise<import('../core/model_listing').RemoteModels>,
    private readonly log: (line: string) => void,
    startFiles?: import('../core/coordination/serve_owned').ServePort['startFiles']
  ) {
    const windowId = vscode.env.sessionId;
    this.remote = new RemoteSwitch({
      windowId,
      entry: () => this.entry(),
      allowlist: () => allowlist(),
      space: () => space(),
      credentials: (entry) => this.credentials(entry),
      messenger: (entry, credentials, signal) => messengerFor(entry, credentials, signal),
      identity: () => identity(windowId),
      own: () =>
        ownedSessions(windowId).map((session) => {
          const state = ownedSession(session.pid)?.state;
          return {
            session,
            ...ownedIncomingSnapshot(session.pid),
            pending: state?.pending ?? [],
            ...(state?.messageFacts === undefined ? {} : { messageFacts: state.messageFacts }),
            ...(state?.exit === undefined ? {} : { exit: state.exit })
          };
        }),
      sessions: {
        owned: ownedSession,
        end: (pid, startedAt) => endSession(pid, startedAt),
        ending: isEnding,
        start: startHere,
        models: modelsHere,
        startFiles,
        evidence: ownedIncomingEvidence,
        deliverIncoming,
        holder: async () => readHolder(await scanProcesses()),
        incomingHolder: () => incomingHolderNow(windowId, this.remote.incomingHolder())
      },
      processes: (fresh) => scanProcesses(fresh),
      published: () => readPublished(),
      lineage: () => readLineage(),
      claims: () => readClaims(),
      memory: this.memoryPort(),
      keeper: {
        requestCheck: () => keeper.registration.requestCheck(),
        reason: () => keeper.reason,
        holdsForRemote: () => keeper.holdsForRemote
      },
      register: (name, check) => runtime.register(name, REMOTE_CHANGE_MS, check),
      clock: Date.now,
      log,
      changed: () => this.changed.fire()
    });
    this.checks = new CheckRunner({
      entry: () => checkedEntry(this.entry()),
      credentials: (entry) => this.credentials(entry),
      space: {
        read: () => space(),
        fill: async (found) => {
          try {
            await writeSpace(found);
            this.log('remote: the setup check filled in the space setting');
          } catch (error) {
            this.log(`remote: the space the setup check found was not saved — ${String(error)}`);
          }
        }
      },
      clock: Date.now,
      changed: () => this.changed.fire()
    });
    this.unsubscribe.push(
      onOwnedChange(() => this.remote.noticeChange()),
      onSessionState(() => this.remote.noticeChange())
    );
    // Any window's store fires this, so a token pasted elsewhere clears the
    // verdict here too.
    const secrets = context.secrets.onDidChange((e) => {
      void this.checks.secretChanged(e.key);
      void this.remote.secretChanged(e.key);
    });
    const settings = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('squadron.remote.messenger')) this.checks.invalidate();
      if (
        e.affectsConfiguration('squadron.remote.allowlist') ||
        e.affectsConfiguration('squadron.remote.space') ||
        e.affectsConfiguration('squadron.remote.messenger') ||
        e.affectsConfiguration('squadron.remote.fakeLink')
      ) {
        void this.remote.settingsChanged();
      }
    });
    this.unsubscribe.push(() => {
      secrets.dispose();
      settings.dispose();
    });
    void this.remote.refreshPresence();
  }

  /** `RemoteSwitch.restore`. */
  restore(): Promise<void> {
    return this.remote.restore();
  }

  /** `RemoteSwitch.holds`. */
  incomingHolder(): import('../core/bridge/model').IncomingHolder | undefined {
    return this.remote.incomingHolder();
  }

  holds(): boolean {
    return this.remote.holds();
  }

  fetch(request: Parameters<RemoteSwitch['fetch']>[0]): ReturnType<RemoteSwitch['fetch']> {
    return this.remote.fetch(request);
  }

  housekeep(): Promise<void> {
    return this.remote.housekeep();
  }

  async turnOn(): Promise<void> {
    await this.remote.turnOn();
  }

  /** `RemoteSwitch.turnOff`. */
  turnOff(): Promise<void> {
    return this.remote.turnOff();
  }

  /** The palette's spelling of `setField`: every field in turn, stopping at
   *  the first left empty. */
  async connect(): Promise<void> {
    for (const field of this.entry().setup.fields) {
      if (!(await this.setField(field.key))) return;
    }
  }

  /** The palette's spelling of `forget`. */
  disconnect(): Promise<void> {
    return this.forget();
  }

  /**
   * Prompts for one credential of the chosen messenger and stores it. A key
   * that messenger does not list stores nothing: M4 relays the key from a
   * webview message. An empty or dismissed answer stores nothing either.
   */
  async setField(key: string): Promise<boolean> {
    const entry = this.entry();
    const field = entry.setup.fields.find((one) => one.key === key);
    if (!field) {
      this.log(`remote: ${entry.label} has no field "${key}"; nothing stored`);
      return false;
    }
    const value = (
      await vscode.window.showInputBox({
        title: field.label,
        prompt: `${entry.label}. Kept in the OS keychain, not in settings.`,
        password: true,
        ignoreFocusOut: true
      })
    )?.trim();
    if (!value) return false;
    await this.context.secrets.store(link.secretKey(entry.id, field.key), value);
    // Whether the store's own change event has landed yet is not observed;
    // the runner tells it from a later one by what the credentials read.
    this.checks.invalidate();
    void this.checks.start();
    await this.remote.refreshPresence();
    return true;
  }

  /**
   * The allowed accounts as the page says they should be after an edit,
   * application-scoped so only the user's own settings can name a driver.
   * What the chosen messenger refuses of what the edit adds is left out and
   * answered; the rest is written. A failed write throws.
   */
  async setAllowlist(ids: readonly string[]): Promise<{ account: string; reason: string }[]> {
    const { write, refused } = admitAccounts(this.entry().accounts, allowlist(), ids);
    await vscode.workspace
      .getConfiguration('squadron')
      .update('remote.allowlist', write, vscode.ConfigurationTarget.Global);
    return refused;
  }

  /**
   * The chosen messenger's space: `value`, or asked in the host's own input
   * box, which the messenger's rule validates as it is typed. An empty answer
   * clears it; a dismissed one, or a value the rule refuses, changes nothing.
   */
  async setSpace(value?: string): Promise<void> {
    const entry = this.entry();
    const words = entry.setup.sender.space;
    if (!words) return;
    const answer =
      value ??
      (await vscode.window.showInputBox({
        title: words.label,
        prompt: `${words.help} Left empty, the next check fills it again.`,
        value: space() ?? '',
        ...(words.placeholder === undefined ? {} : { placeHolder: words.placeholder }),
        ignoreFocusOut: true,
        validateInput: (typed) => {
          const trimmed = typed.trim();
          return trimmed === '' ? undefined : entry.accounts.refuseSpace(trimmed);
        }
      }));
    if (answer === undefined) return;
    const trimmed = answer.trim();
    const refused = trimmed === '' ? undefined : entry.accounts.refuseSpace(trimmed);
    if (refused !== undefined) {
      this.log(`remote: the ${words.label} was not saved — ${refused}`);
      return;
    }
    await writeSpace(trimmed === '' ? undefined : trimmed);
  }

  /** `CheckRunner.start`: asks the chosen messenger whether its stored
   *  credentials would connect. Ignored while one is in flight. */
  check(): Promise<void> {
    return this.checks.start();
  }

  /** Deletes every credential of the chosen messenger. Remote, if on, goes
   *  off on the change with the reason `canTurnOn` gives. */
  async forget(): Promise<void> {
    const entry = this.entry();
    for (const field of entry.setup.fields) {
      await this.context.secrets.delete(link.secretKey(entry.id, field.key));
    }
    this.checks.invalidate();
    await this.remote.refreshPresence();
  }

  /** `RemoteSwitch.view`, with the check runner's state on it. */
  async view(): Promise<RemoteView> {
    return { ...(await this.remote.view()), check: this.checks.state() };
  }

  /** `RemoteSwitch.redact`, for the panel's own lines about Remote. */
  redact(text: string): Promise<string> {
    return this.remote.redact(text);
  }

  /** `RemoteSwitch.redacted`. */
  redacted(text: string): Promise<string | undefined> {
    return this.remote.redacted(text);
  }

  /** The chosen messenger's own setup words — the steps, the blob to copy and
   *  the create link — which the panel draws and acts on. */
  messengerSetup(): MessengerSetup {
    return this.entry().setup;
  }

  /** M3's file, into its root's conversation. */
  attach(addr: SessionAddr, attachment: Attachment): Promise<Attached> {
    return this.remote.attach(addr, attachment);
  }

  /** Where M3's file would go, on a pass run now. */
  attachTarget(addr: SessionAddr): Promise<Target> {
    return this.remote.attachTarget(addr);
  }

  /**
   * The window is going: off, with the off-time stamped and the switch kept,
   * so a reload within `RESTORE_MS` restores it. Awaited by `deactivate`, so
   * the holder file goes before the host does.
   */
  async dispose(): Promise<void> {
    // First: the stamp is written before this returns.
    const off = this.remote.dispose();
    this.checks.dispose();
    for (const stop of this.unsubscribe.splice(0)) stop();
    try {
      await off;
    } finally {
      this.changed.dispose();
    }
  }

  private entry(): MessengerEntry {
    return link.chooseMessenger(
      vscode.workspace.getConfiguration('squadron').get<string>('remote.messenger'),
      { unlisted: this.context.extensionMode !== vscode.ExtensionMode.Production }
    );
  }

  /** Read at a turn-on or a rebuild (`canTurnOn`, then the messenger's
   *  `create`), on a change of a setting or a secret (which fields are
   *  stored), and to redact a line. Kept by nothing here. */
  private async credentials(entry: MessengerEntry): Promise<Credentials> {
    const values: Record<string, string> = {};
    for (const field of entry.setup.fields) {
      const value = (await this.context.secrets.get(link.secretKey(entry.id, field.key)))?.trim();
      if (value) values[field.key] = value;
    }
    return values;
  }

  /** The memory file, or none in a window with no workspace storage — an
   *  empty window, whose Remote is never restored. */
  private memoryPort(): MemoryPort {
    const dir = this.context.storageUri?.fsPath;
    const file = dir === undefined ? undefined : path.join(dir, MEMORY_FILE);
    return {
      read: async () =>
        file === undefined ? undefined : fs.promises.readFile(file, 'utf8').catch(() => undefined),
      write: (text) => {
        if (file === undefined) return;
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, text);
        } catch (err) {
          this.log(
            `remote: could not remember the switch: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    };
  }
}

function allowlist(): string[] {
  return normalizeAllowlist(
    vscode.workspace.getConfiguration('squadron').get<unknown>('remote.allowlist')
  );
}

/** The space setting, trimmed, or nothing when unset or not a string. */
function space(): string | undefined {
  const value = vscode.workspace.getConfiguration('squadron').get<unknown>('remote.space');
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Application-scoped, like the allowlist it composes with. */
function writeSpace(value: string | undefined): Thenable<void> {
  return vscode.workspace
    .getConfiguration('squadron')
    .update('remote.space', value, vscode.ConfigurationTarget.Global);
}

/** The chosen messenger, and the fake's file driver when the fake is chosen. */
async function messengerFor(
  entry: MessengerEntry,
  credentials: Credentials,
  signal: AbortSignal
): Promise<Built> {
  if (entry.id === 'fake') {
    // Built here rather than through `create`, because the file driver
    // needs the fake's own handle.
    const held = vscode.workspace.getConfiguration('squadron').get('remote.fakeLink') === 'held';
    const fake = fakeMessenger({ credentials, ...(held ? { held: true } : {}) });
    return { ok: true, messenger: fake, driver: await driveFake(fake) };
  }
  return entry.create(credentials, signal);
}

/** The entry the check runner asks: the chosen one, or with the fake chosen,
 *  the fake answering the verdict `squadron.remote.fakeCheck` names, each
 *  check recorded under its directory. */
function checkedEntry(entry: MessengerEntry): MessengerEntry {
  if (entry.id !== 'fake') return entry;
  return checkedFake(vscode.workspace.getConfiguration('squadron').get('remote.fakeCheck'));
}

/** This extension host as a holder: its pid at its start, and the name its
 *  window's claim gives it. */
let incomingGeneration = 0;
async function identity(windowId: string): Promise<Holder | undefined> {
  let startedAt = (await scanProcesses()).starts.get(process.pid);
  startedAt ??= (await scanProcesses(true)).starts.get(process.pid);
  if (startedAt === undefined) return undefined;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const capability = await ownedHostIdentity();
  return {
    ...(capability
      ? { incoming: { host: capability.host, generation: ++incomingGeneration } }
      : {}),
    windowId,
    label: vscode.workspace.name ?? '(no folder)',
    ...(folder === undefined ? {} : { folder }),
    pid: process.pid,
    startedAt,
    since: Date.now()
  };
}
