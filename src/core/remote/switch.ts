/**
 * Remote's switch in one window, and the pass that feeds its engine: when
 * Remote turns on here, what it does on the way, when it goes off on its own,
 * and how a change of credentials or allowlist rebuilds it. Every effect is a
 * port, so `host/remote.ts` runs this over `vscode` and the two-window test
 * (`remote_helpers.ts`) runs the same class over its test windows.
 *
 * **The switch is the holder file, not a setting (D37).** A setting is
 * application-scoped and would turn Remote on in every window. Turning on runs
 * `canTurnOn`, `acquireHolder`, the messenger's create and the engine's
 * `start`, in that order; turning off stops the engine and only then releases
 * the holder, so a second window cannot load the conversation store while this
 * one still writes it.
 *
 * **No host notification anywhere.** A refusal or a failure goes into the
 * state, which the panel draws, and into the log.
 */

import type { AwakeReason } from '../awake';
import { canTurnOn, resolveAccounts, waitsOnSpace, type ResolvedAccounts } from '../bridge/allow';
import { Bridge, type Observed } from '../bridge/bridge';
import {
  acquireHolder,
  namedHolder,
  readHolder,
  ownsHolder,
  sameHolder,
  releaseHolder,
  type Holder
} from './holder';
import type { Attached, Attachment, SessionAddr, Watched } from '../bridge/model';
import {
  unfit,
  type Credentials,
  type LinkState,
  type Messenger,
  type MessengerEntry
} from '../bridge/port';
import * as words from '../bridge/words';
import { ask } from '../coordination/ask';
import type { LineageEntry } from '../coordination/lineage';
import { endBySignal, Reaps } from '../control';
import type { WindowClaim } from '../model';
import * as perf from '../perf';
import type { PublishedLive } from '../published';
import { pruneIncomingPublished } from '../published';
import type { CheckRegistration } from '../reconcile';
import type { ProcessTable } from '../scan';
import { findTarget, remoteBoard, type OwnSession, type Target } from './board';
import type { FakeDriver } from './fake_files';
import * as link from './link';
import type { RemoteEvent, RemoteSetup, RemoteState, RemoteView, TurnedOn } from './link';
import { remoteVerbs, type VerbPort } from './verbs';
import { IncomingFiles } from './incoming';
import type { FetchFileIdentity, FetchFileReply } from '../bridge/model';

type Starts = Pick<ProcessTable, 'starts' | 'complete' | 'startSource'>;

/** The messenger a turn-on builds, and the fake's file driver when the fake
 *  is chosen; or why it could not be built. */
export type Built =
  { ok: true; messenger: Messenger; driver?: FakeDriver } | { ok: false; reason: string };

/** Where the remembered switch is kept: a file of this window's, or none. */
export type MemoryPort = {
  /** The text last written, or nothing when there is none to read. */
  read(): Promise<string | undefined>;
  /**
   * Written before this returns, every time. A closing host may exit within
   * milliseconds, so the close's stamp cannot wait; and a write still in
   * flight when it lands would land over it, and the window would read as
   * crashed, which a reload does not restore (U12).
   */
  write(text: string): void;
};

/** Everything the switch reaches outside itself. */
export type SwitchPort = {
  /** This window, as its claim and the holder file name it. */
  windowId: string;
  /** The messenger the settings choose. */
  entry(): MessengerEntry;
  /** The allowlist setting, normalized: accounts as the reader entered them. */
  allowlist(): string[];
  /** The space setting, trimmed; nothing when unset. Absent reads as unset. */
  space?(): string | undefined;
  /** Each stored credential of `entry`'s fields. */
  credentials(entry: MessengerEntry): Promise<Credentials>;
  messenger(entry: MessengerEntry, credentials: Credentials, signal: AbortSignal): Promise<Built>;
  /** This window as a holder, or nothing when its start cannot be read. */
  identity(): Promise<Holder | undefined>;
  /** This window's sessions, read off their handles. */
  own(): readonly OwnSession[];
  /** The verbs' reach into this window's handles and its starts. */
  sessions: Pick<
    VerbPort,
    | 'owned'
    | 'end'
    | 'ending'
    | 'start'
    | 'models'
    | 'startFiles'
    | 'evidence'
    | 'deliverIncoming'
    | 'holder'
    | 'incomingHolder'
  >;
  /** The process table; `fresh` skips the shared cache. */
  processes(fresh: boolean): Promise<Starts>;
  published(): Promise<ReadonlyMap<number, PublishedLive>>;
  lineage(): Promise<ReadonlyMap<number, LineageEntry>>;
  claims(): Promise<readonly WindowClaim[]>;
  memory: MemoryPort;
  /** Keep-awake: told whenever the switch moves, and asked its reason and
   *  whether the reader lets it hold for Remote, for the view. */
  keeper: { requestCheck(): void; reason(): AwakeReason | undefined; holdsForRemote(): boolean };
  /** A Reconciler tenant: the pass's, and each engine's own retries. */
  register(name: string, check: () => Promise<void>): CheckRegistration;
  clock(): number;
  log(line: string): void;
  /** Anything `view()` answers has moved. */
  changed(): void;
};

/** Remote as this window holds it: the engine, and what it was built from. */
type On = {
  me: Holder;
  entry: MessengerEntry;
  messenger: Messenger;
  bridge: Bridge;
  files: IncomingFiles;
  filesReady: boolean;
  halted: boolean;
  driver?: FakeDriver;
  stopLink(): void;
};

type Prepared = {
  entry: MessengerEntry;
  credentials: Credentials;
  allowlist: string[];
};

export class RemoteSwitch {
  private state: RemoteState;
  private on: On | undefined;
  private construction: AbortController | undefined;
  /** Whether each credential field of the chosen messenger is stored, so a
   *  poll of `view()` reads no secret. */
  private present = new Map<string, boolean>();
  /** Turn-on, turn-off and rebuild, one at a time. */
  private switching: Promise<unknown> = Promise.resolve();
  /** Every pass, scheduled or run now for an attachment, one at a time: two
   *  `observe` calls against one previous board would post an edge twice. */
  private passes: Promise<unknown> = Promise.resolve();
  /** Link moves, in the order they arrived; each reads the secrets to redact
   *  against before it is applied. */
  private links: Promise<unknown> = Promise.resolve();
  /** What the last pass built, for `attachTarget` and the verbs. */
  private board: readonly Watched[] = [];
  private table: Starts | undefined;
  /** End's SIGKILL backstops, cancelled when this switch goes, and at once
   *  for an End that outlives it. */
  private readonly reaps = new Reaps();
  /** The remembered switch as last written, which the close stamps. */
  private readonly memory = new link.SwitchMemory();
  private readonly registration: CheckRegistration;
  private disposed = false;
  private readonly evidenceListeners = new Set<() => void>();
  private housekeeping: Promise<void> | undefined;

  constructor(private readonly port: SwitchPort) {
    this.state = link.initialRemote(this.setup());
    // The pass's own chain logs its error redacted; the Reconciler would log
    // it again, raw.
    this.registration = port.register('remote pass', () => this.pass().catch(() => undefined));
  }

  /** Turns Remote back on if this window held it when it went, and went
   *  under `RESTORE_MS` ago — a reload, never a crash or a later reopen. */
  async restore(): Promise<void> {
    const memory = link.readRemembered(await this.port.memory.read());
    this.memory.set(memory);
    if (link.restores({ remembered: memory.on, offAt: memory.offAt, now: this.port.clock() })) {
      this.port.log('remote: restoring after a restart');
      // Refused because another window holds Remote, the "on" is forgotten:
      // kept, every later close would stamp it afresh, and a reload long after
      // the person turned Remote off in that window would turn it on here.
      // Any other refusal, or a throw (the chain logged it), may pass, so the
      // next start tries again. A close in between is no refusal.
      const turned = await this.turnOn({ restored: true }).catch(() => undefined);
      if (turned && !turned.ok && turned.holder && !this.disposed) this.remember({ on: false });
    } else if (memory.on) {
      this.remember({ on: false });
    }
  }

  incomingHolder(): import('../bridge/model').IncomingHolder | undefined {
    return this.on?.filesReady ? this.on.me.incoming : undefined;
  }

  /** This window holds Remote and its engine is built. */
  holds(): boolean {
    return this.on !== undefined;
  }

  fetch(request: {
    requestId: string;
    identity: FetchFileIdentity;
    signal?: AbortSignal;
  }): Promise<FetchFileReply> {
    return this.on?.filesReady
      ? this.on.files.fetch(request)
      : Promise.resolve({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          kind: 'refused',
          code: 'remote-off'
        });
  }

  housekeep(): Promise<void> {
    if (this.housekeeping) return this.housekeeping;
    const on = this.on;
    if (!on) return Promise.resolve();
    const work = (async () => {
      if (!(await ownsHolder(on.me))) {
        this.halt();
        return;
      }
      const table = await this.port.processes(true);
      if (this.on !== on) return;
      await on.bridge.housekeep(table);
      if (!(await ownsHolder(on.me))) {
        this.halt();
        return;
      }
      await pruneIncomingPublished(table);
      const models = await this.port.sessions.models?.();
      if (models?.incomingAccess && this.on === on) await on.files.sweep(models.incomingAccess);
    })();
    this.housekeeping = work;
    void work
      .finally(() => {
        if (this.housekeeping === work) this.housekeeping = undefined;
      })
      .catch(() => {});
    return work;
  }

  /** On, or why not; a refusal is in the state as well. A person's turn-on
   *  catches up nothing sent while Remote was off; `restored` after a reload
   *  catches up what the reload missed. */
  turnOn(options: { restored?: boolean } = {}): Promise<TurnedOn> {
    return this.serially(async (): Promise<TurnedOn> => {
      if (this.on) return { ok: true };
      if (this.disposed) return { ok: false, reason: 'This window is closing.' };
      const prepared = await this.prepare();
      if (!prepared.ok) return this.refuse({ ...prepared, cause: 'setup' });
      const me = await this.port.identity();
      if (!me) return this.refuse({ ok: false, reason: 'Remote could not read this window.' });
      // Fresh: the cached table can call a holder that died within the last
      // second alive, refusing the takeover. A press is rare; one `ps` each.
      const acquired = await acquireHolder(
        me,
        await this.port.processes(true),
        await this.port.claims()
      );
      if (!acquired.ok) {
        return this.refuse(
          acquired.holder
            ? { ok: false, holder: acquired.holder }
            : { ok: false, reason: 'Another window was turning Remote on. Try again.' }
        );
      }
      this.remember({ on: true });
      const built = await this.build(me, prepared, undefined, !options.restored);
      if (!built.ok) {
        if (!this.disposed) this.remember({ on: false });
        await releaseHolder(me);
        return this.refuse({ ok: false, reason: built.reason });
      }
      this.port.log(`remote: on, ${built.on.entry.label}`);
      this.switched();
      return { ok: true };
    });
  }

  /** Off by a person: the switch is forgotten, so a reload does not restore.
   *  Already off, it dismisses the refusal or reason drawn. */
  turnOff(): Promise<void> {
    this.halt();
    return this.serially(async () => {
      if (!this.on) this.apply({ kind: 'turnOff' });
      await this.stop({ forget: true });
    });
  }

  /**
   * What the panel draws. Cheap enough for every 3 s refresh in every window:
   * the shared process table, one small file, no secret. The holder read is
   * not memoised, because a holder that crashed writes nothing and would
   * otherwise be drawn as holding until some unrelated write.
   */
  async view(): Promise<RemoteView> {
    if (!this.on) {
      const holder = await readHolder(await this.port.processes(false));
      // Our own file, mid-turn-on, is not another window's.
      if (holder?.windowId !== this.port.windowId) this.apply({ kind: 'holderSeen', holder });
    }
    return link.remoteView(
      this.state,
      this.port.keeper.reason() ?? 'idle',
      this.port.keeper.holdsForRemote()
    );
  }

  /** M3's file, into its root's conversation. */
  attach(addr: SessionAddr, attachment: Attachment): Promise<Attached> {
    const on = this.on;
    if (!on) return Promise.resolve({ ok: false, reason: words.OFF_HERE });
    return on.bridge.attach(addr, attachment);
  }

  /**
   * Where M3's file would go, found on a pass run now rather than after the
   * coalescing window, so a session started inside it is on the board. The
   * pass shares the scheduled one's chain; one run early posts what had come
   * due, once.
   */
  async attachTarget(addr: SessionAddr): Promise<Target> {
    if (!this.on) return { ok: false, reason: words.OFF_HERE };
    await this.pass(true);
    const on = this.on;
    if (!on || !this.table) return { ok: false, reason: words.OFF_HERE };
    return findTarget(this.board, addr, this.table.starts, on.messenger.files);
  }

  /**
   * One look at the machine for the engine: the board, the holder, then the
   * edges, the held prompts' expiry, and the next deadline. The Reconciler's
   * check; `fresh` reads the process table past its cache.
   */
  pass(fresh = false): Promise<void> {
    const next = this.passes.then(() => this.passOnce(fresh));
    this.passes = next.catch((err: unknown) => this.logClean(`remote pass: ${message(err)}`));
    return next;
  }

  /** Settles the held prompts that are due, behind every inbound event
   *  already delivered, observing nothing. A test's drain: the pass does the
   *  same after its observe. */
  async tick(): Promise<void> {
    await this.on?.bridge.tick(this.port.clock());
  }

  /** An owned session changed: the pass is due within its window. */
  noticeChange(): void {
    for (const listener of this.evidenceListeners) listener();
    if (this.on) this.registration.noticeChange();
  }

  /** A secret changed: one of the chosen messenger's fields rebuilds. */
  async secretChanged(key: string): Promise<void> {
    const entry = this.port.entry();
    if (!entry.setup.fields.some((field) => link.secretKey(entry.id, field.key) === key)) return;
    this.halt();
    await this.refreshPresence();
    await this.rebuild();
  }

  /** The messenger or the allowlist setting changed. */
  async settingsChanged(): Promise<void> {
    const on = this.on;
    const provider = on?.messenger.incomingFiles;
    if (on?.me.incoming && provider) {
      const entry = this.port.entry();
      void on.bridge
        .observeIncomingPolicy(
          {
            messengerId: entry.id,
            installId: provider.installId,
            allowedIds: this.accounts(entry).ids
          },
          on.me.incoming
        )
        .catch(() => {});
    }
    this.halt();
    await this.refreshPresence();
    await this.rebuild();
  }

  /** Reads which fields are stored, for the view's setup. */
  async refreshPresence(): Promise<void> {
    const entry = this.port.entry();
    const credentials = await this.port.credentials(entry);
    this.present = new Map(
      entry.setup.fields.map((field) => [field.key, !!credentials[field.key]] as const)
    );
    this.apply({ kind: 'setup', setup: this.setup() });
  }

  /**
   * The window is going: off, with the off-time stamped and the switch kept,
   * so a reload within `RESTORE_MS` restores it. Resolves once the holder file
   * is released.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Before anything that can wait: the host may exit within milliseconds.
    // From the remembered switch, not `this.on`, which a rebuild clears.
    const stamped = this.memory.close(this.port.clock());
    if (stamped) this.port.memory.write(JSON.stringify(stamped));
    this.reaps.dispose();
    this.registration.dispose();
    this.halt();
    await this.serially(() => this.stop({ forget: false }));
  }

  private async passOnce(fresh: boolean): Promise<void> {
    const on = this.on;
    if (!on) return;
    perf.record('remote');
    const [table, published, lineage, claims] = await Promise.all([
      this.port.processes(fresh),
      this.port.published(),
      this.port.lineage(),
      this.port.claims()
    ]);
    // Against this host itself, which is alive by definition: no process
    // table, so a `ps` that failed cannot turn Remote off.
    const holder = await namedHolder();
    if (this.on !== on) return;
    if (!holder || !sameHolder(holder, on.me)) {
      this.halt();
      const reason = link.holderLost(holder && { label: holder.label });
      this.port.log(`remote: ${reason}`);
      void this.serially(async () => {
        if (this.on === on) await this.stop({ forget: true, reason });
      });
      return;
    }
    // A `ps` that failed (`holderAlive`'s rule): built from it, the board
    // would lose every other window's session and settle what each asked.
    if (table.starts.size === 0) return;
    this.board = remoteBoard({
      windowId: on.me.windowId,
      own: this.port.own(),
      published,
      starts: table.starts,
      lineage
    });
    this.table = table;
    const observation = on.bridge.observe(this.board, claims);
    const ticking = on.bridge.tick(this.port.clock());
    await observation;
    await ticking;
    if (this.on === on) this.registration.schedule(on.bridge.nextDeadline());
  }

  /** `canTurnOn` over the chosen messenger's stored fields and the accounts
   *  it can use, which are what the engine is handed. */
  private async prepare(): Promise<({ ok: true } & Prepared) | { ok: false; reason: string }> {
    const entry = this.port.entry();
    const credentials = await this.port.credentials(entry);
    const { ids, unusable } = this.accounts(entry);
    const words = entry.setup.sender.space;
    const verdict = canTurnOn({
      fields: entry.setup.fields,
      credentials,
      allowlist: ids,
      ...(words && waitsOnSpace(unusable)
        ? { space: { label: words.label, set: this.port.space?.() !== undefined } }
        : {})
    });
    return verdict.ok ? { ok: true, entry, credentials, allowlist: ids } : verdict;
  }

  private accounts(entry: MessengerEntry): ResolvedAccounts {
    return resolveAccounts(entry.accounts, this.port.allowlist(), this.port.space?.());
  }

  /** The messenger and the engine over it. The credentials go into the
   *  messenger and nowhere else. */
  private async build(
    me: Holder,
    prepared: Prepared,
    observed?: Observed,
    fresh = false
  ): Promise<{ ok: true; on: On } | { ok: false; reason: string }> {
    const { entry, credentials, allowlist } = prepared;
    if (this.disposed) return { ok: false, reason: 'This window is closing.' };
    const construction = new AbortController();
    this.construction = construction;
    let made: Built;
    try {
      made = await this.port.messenger(entry, credentials, construction.signal);
    } finally {
      if (this.construction === construction) this.construction = undefined;
    }
    if (construction.signal.aborted || this.disposed) {
      if (made.ok) {
        made.messenger.close();
        made.driver?.dispose();
      }
      return { ok: false, reason: 'Remote construction was cancelled.' };
    }
    if (!made.ok) return made;
    const { messenger, driver } = made;
    const refused = unfit(messenger, entry.label);
    if (refused !== undefined) {
      driver?.dispose();
      return { ok: false, reason: refused };
    }
    const verbs = remoteVerbs({
      windowId: me.windowId,
      holderIdentity: me.incoming,
      ...this.port.sessions,
      ask: (body, timeoutMs) => ask(body, timeoutMs),
      board: () => this.board,
      claims: () => this.port.claims(),
      signal: (targets) => endBySignal(targets, this.reaps)
    });
    const bridge = new Bridge({
      messenger,
      label: entry.label,
      verbs,
      holder: me,
      allowlist,
      ...(observed ? { observed } : {}),
      ...(fresh ? { fresh } : {}),
      claims: () => this.port.claims(),
      clock: () => this.port.clock(),
      register: (name, check) => this.port.register(name, check),
      log: (line) => void this.logClean(line)
    });
    const stopLink = bridge.onLink((state) => this.linked(state));
    const files = new IncomingFiles({
      bridge,
      verbs,
      messenger,
      currentHolder: async () => {
        const current = await ownsHolder(me);
        if (!current) {
          files.dispose().catch(() => {});
          void bridge.stop();
        }
        return current;
      },
      onEvidenceChanged: (listener) => {
        this.evidenceListeners.add(listener);
        return () => this.evidenceListeners.delete(listener);
      }
    });
    const on: On = {
      me,
      entry,
      messenger,
      bridge,
      files,
      filesReady: false,
      halted: false,
      ...(driver ? { driver } : {}),
      stopLink
    };
    this.on = on;
    this.apply({ kind: 'turnOn', result: { ok: true } });
    const failed = async (err: unknown) => {
      await this.teardown(on);
      this.apply({ kind: 'turnOff' });
      return { ok: false as const, reason: `Remote could not start: ${message(err)}` };
    };
    try {
      await bridge.load();
      if (me.incoming && messenger.incomingFiles)
        await bridge.observeIncomingPolicy(
          {
            messengerId: messenger.id,
            installId: messenger.incomingFiles.installId,
            allowedIds: allowlist
          },
          me.incoming
        );
      if (me.incoming) {
        const models = await this.port.sessions.models?.();
        if (models?.incomingAccess) await files.sweep(models.incomingAccess);
      }
      on.filesReady = !on.halted;
    } catch (err) {
      return failed(err);
    }
    // The first pass before the connection: an event routed against an empty
    // board finds no root for a reply, no session for a press and no folder
    // for a job. One that fails is logged on its chain; the next one comes.
    await this.pass().catch(() => undefined);
    try {
      bridge.connect();
    } catch (err) {
      return failed(err);
    }
    this.linked(bridge.link());
    driver?.start();
    return { ok: true, on };
  }

  /**
   * Stops the engine now, ahead of the switching chain, which may be waiting
   * on it: a turn-on's first pass runs before any connection, and a post it
   * hangs on would hold the off behind it. The chain's own stop follows and
   * releases the holder.
   */
  private halt(): void {
    this.construction?.abort();
    if (this.on) {
      this.on.halted = true;
      this.on.filesReady = false;
    }
    void this.on?.files.dispose();
    void this.on?.bridge.stop();
  }

  /** Stops the engine, then releases the holder: never the other order. */
  private async stop(options: {
    forget: boolean;
    reason?: string;
    cause?: link.Cause;
  }): Promise<void> {
    if (options.forget) this.remember({ on: false });
    const on = this.on;
    if (!on) return;
    await this.teardown(on);
    await this.release(on.me, options.reason, options.cause);
  }

  /** From here nothing posts or writes: `Bridge.stop` resolves once the pass
   *  in flight has drained. */
  private async teardown(on: On): Promise<void> {
    this.on = undefined;
    on.stopLink();
    on.driver?.dispose();
    await Promise.all([on.bridge.stop(), on.files.dispose(), this.housekeeping]);
    await on.driver?.flush();
    this.board = [];
  }

  private async release(me: Holder, reason: string | undefined, cause?: link.Cause): Promise<void> {
    await releaseHolder(me);
    this.port.keeper.requestCheck();
    if (this.disposed) return;
    this.registration.schedule(undefined);
    this.apply(
      {
        kind: 'turnOff',
        ...(reason === undefined ? {} : { reason }),
        ...(cause === undefined ? {} : { cause })
      },
      reason === undefined ? [] : await this.secretValues()
    );
  }

  /**
   * New credentials or a new allowlist, while on: the engine is built again
   * under the same holder, from what the old one observed, or Remote goes off
   * with the reason it cannot.
   */
  private rebuild(): Promise<void> {
    this.halt();
    return this.serially(async () => {
      const on = this.on;
      if (!on) return;
      const prepared = await this.prepare();
      if (!prepared.ok) {
        return this.stop({ forget: true, reason: prepared.reason, cause: 'setup' });
      }
      await this.teardown(on);
      const me = await this.port.identity();
      if (
        !me ||
        !(await acquireHolder(me, await this.port.processes(true), await this.port.claims())).ok
      ) {
        return this.release(on.me, 'Remote could not renew this window.');
      }
      const built = await this.build(me, prepared, on.bridge.observation());
      if (!built.ok) {
        this.remember({ on: false });
        return this.release(me, built.reason);
      }
      this.port.log('remote: rebuilt on a change of settings or credentials');
      this.switched();
    });
  }

  /** The switch moved on: keep-awake looks again. */
  private switched(): void {
    this.port.keeper.requestCheck();
  }

  /** Drawn before the switch's next move runs: applied after it, a late
   *  refusal would paint "on elsewhere" over a Remote that came on. */
  private async refuse(result: Extract<TurnedOn, { ok: false }>): Promise<TurnedOn> {
    this.apply({ kind: 'turnOn', result }, await this.secretValues());
    if (this.state.refused) this.port.log(`remote: not turned on — ${this.state.refused.reason}`);
    return result;
  }

  /** A link coming back asks for a pass, which posts what failed while it
   *  was down; a warning on a link already up is no return. */
  private linked(state: LinkState): void {
    this.links = this.links.then(async () => {
      if (!this.on) return;
      const was = this.state.state.kind;
      this.apply({ kind: 'link', link: state }, await this.secretValues());
      if (state.kind === 'connected' && was !== 'connected') this.registration.noticeChange();
    });
  }

  private apply(event: RemoteEvent, secrets: readonly string[] = []): void {
    const before = this.state;
    this.state = link.remoteReduce(before, event, { now: this.port.clock(), secrets });
    if (JSON.stringify(this.state) === JSON.stringify(before)) return;
    // The state's move goes to the log as well as the view: the view holds
    // only the latest, and the log is where a reader traces the moves.
    if (JSON.stringify(this.state.state) !== JSON.stringify(before.state)) {
      this.port.log(`remote: ${describe(this.state.state)}`);
    }
    this.port.changed();
  }

  private setup(): RemoteSetup {
    const entry = this.port.entry();
    const { unusable } = this.accounts(entry);
    const space = this.port.space?.();
    const refused = space === undefined ? undefined : entry.accounts.refuseSpace(space);
    return {
      messenger: { id: entry.id, label: entry.label },
      fields: entry.setup.fields.map((field) => ({
        key: field.key,
        label: field.label,
        set: this.present.get(field.key) === true
      })),
      allowlist: this.port.allowlist(),
      ...(unusable.length > 0 ? { unusable } : {}),
      ...(entry.setup.sender.space
        ? {
            space: {
              ...(space === undefined ? {} : { value: space }),
              ...(refused === undefined ? {} : { refused })
            }
          }
        : {})
    };
  }

  private async secretValues(): Promise<string[]> {
    return Object.values(await this.port.credentials(this.port.entry()));
  }

  /** `text` with every stored credential value of the chosen messenger as
   *  `…`, for a log line that may quote another program's words. Never
   *  throws: with the credentials unreadable, the line is withheld whole. */
  async redact(text: string): Promise<string> {
    return (
      (await this.redacted(text)) ??
      'remote: a log line was withheld: the credentials to redact it could not be read'
    );
  }

  /** `text` as `redact` answers it, or nothing to quote when the credentials
   *  cannot be read: for a reason a person reads, not a log line. */
  async redacted(text: string): Promise<string | undefined> {
    try {
      return link.redact(text, await this.secretValues());
    } catch {
      return undefined;
    }
  }

  private async logClean(line: string): Promise<void> {
    this.port.log(await this.redact(line));
  }

  private remember(next: link.Remembered): void {
    this.port.memory.write(JSON.stringify(this.memory.set(next)));
  }

  private serially<T>(step: () => Promise<T>): Promise<T> {
    const next = this.switching.then(step);
    this.switching = next.catch((err: unknown) => this.logClean(`remote: ${message(err)}`));
    return next;
  }
}

/** One state as a log line. Every reason in it is already redacted. */
function describe(state: RemoteState['state']): string {
  switch (state.kind) {
    case 'elsewhere':
      return `elsewhere, in ${state.holder.label}`;
    case 'connected':
      return state.warning === undefined ? 'connected' : `connected — ${state.warning}`;
    case 'off':
    case 'reconnecting':
      return state.reason === undefined ? state.kind : `${state.kind} — ${state.reason}`;
    case 'failed':
      return `failed — ${state.reason}`;
    case 'connecting':
      return state.kind;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
