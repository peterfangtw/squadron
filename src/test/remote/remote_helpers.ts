import * as listings from '../../core/model_listing';
/**
 * Two IDE windows in one test process, for `remote_flows.test.ts` and M3's
 * attachment flows. Each window is what `host/` makes of one: a claim file, a
 * registry of real `SessionHandle`s over `childTransport` to a brand's fake
 * CLI, each published on change as `host/sessions.ts` publishes, and a
 * `claimRequests` loop serving what `serveOwned` owns. The holder window adds
 * `RemoteSwitch`, the class the host runs, over the fake messenger, and runs a
 * pass only when a test asks — the one timer here is the claim loop.
 *
 * Load after `tempHome`: every store this reaches resolves `HOME` at import.
 */

import { heldProcess } from '../fixtures/held_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { adapter, type SessionHandle } from '../../core/adapter';
import type { Started } from '../../core/bridge/bridge';
import {
  fakeEntry,
  fakeMessenger,
  type FakeMessenger,
  type FakeOptions
} from '../../core/bridge/fake';
import { readHolder, unclaimAfter, type Holder } from '../../core/remote/holder';
import type { Attached, Attachment, SessionAddr } from '../../core/bridge/model';
import { readClaims, WINDOWS_DIR } from '../../core/coordination/claims';
import { readLineage, writeLineage } from '../../core/coordination/lineage';
import { claimRequests, type Reply, type Request } from '../../core/coordination/requests';
import { serveOwned, type RemoteStart, type ServePort } from '../../core/coordination/serve_owned';
import { toSession } from '../../core/live';
import { sameSessionStart, type BrandId, type Session, type WindowClaim } from '../../core/model';
import { STATE_DIR } from '../../core/paths';
import { publishLive, readPublished, removePublished } from '../../core/published';
import { AttachGuard } from '../../core/remote/attach';
import type { OwnSession, Target } from '../../core/remote/board';
import type { TurnedOn } from '../../core/remote/link';
import type { AttachPort } from '../../core/remote/serve_attach';
import { RemoteSwitch, type SwitchPort } from '../../core/remote/switch';
import { scanProcesses } from '../../core/scan';
import { childTransport } from '../../core/session';
import { outRoot } from '../helpers';
import * as executables from '../../core/platform/executables';

/** The claim loop's interval (a test interval): a window's 30 s heartbeat
 *  and its request poll are the host's, and a test cannot wait on either. */
const LOOP_MS = 100;

/** A further serve function on a window's claim loop, tried before
 *  `serveOwned`: a `Reply` for a shape it owns, else `undefined`. */
export type Arm = (request: Request) => Promise<Reply> | undefined;

/** The one sender the holder's allowlist names. */
export const OWNER = 'T1:U1';
export const STRANGER = 'T1:U9';

/** The credential the holder's messenger is built with. The token proof
 *  searches every file and every child's environment for it. */
export const SENTINEL = 'remote-sentinel-0d5f2c7a';

/** Where every fake CLI logs the environment it was handed (`fixtures/env_log.ts`). */
export function envLog(): string {
  return path.join(os.homedir(), 'fake-env.jsonl');
}

/** Each brand's fake, and what it needs to run several sessions at once:
 *  an id of its own per session, and a turn that ends on its prompt. */
function fixture(brand: BrandId, sessionId: string): { bin: string; env: Record<string, string> } {
  const at = (name: string) => path.join(outRoot(), 'test', 'fixtures', name);
  const env = { FAKE_ENV_LOG: envLog() };
  switch (brand) {
    case 'claude':
      return { bin: at('fake-cli.js'), env };
    case 'grok':
      return { bin: at('fake-acp.js'), env: { ...env, SQUADRON_FAKE_ACP_SESSION_ID: sessionId } };
    case 'codex':
      return {
        bin: at('fake-codex.js'),
        env: {
          ...env,
          FAKE_CODEX_STORE: path.join(os.homedir(), 'fake-codex-threads.json'),
          FAKE_CODEX_ECHO: '1'
        }
      };
  }
}

/** One session this window started, as the registry holds it. */
export type Live = {
  pid: number;
  startedAt: number;
  sessionId: string;
  brand: BrandId;
  handle: SessionHandle;
  addr: SessionAddr;
};

type Entry = Live & {
  stop(): void;
  trace(event: string, detail?: unknown): void;
  timeline: unknown[];
};

/** What a start is asked for. `parent` is a sessionId: the start then writes
 *  the lineage entry a spawn writes, so D16 finds its root. */
export type Spawn = import('../../core/model').LaunchTarget & {
  prompt?: string;
  correlation?: string;
  cwd?: string;
  brand?: BrandId;
  parent?: string;
};

const windows = new Set<TestWindow>();

/** Every window a test opened, closed: its sessions ended, its loop stopped,
 *  its claim and records removed. */
export async function disposeAll(): Promise<void> {
  for (const window of [...windows]) await window.dispose();
}

export async function testWindow(
  id: string,
  brand: BrandId,
  options: { folder?: string; arms?: readonly Arm[] } = {}
): Promise<TestWindow> {
  const folder = await canonical(options.folder ?? workFolder(id));
  const window = new TestWindow(id, brand, folder, options.arms ?? []);
  await window.open();
  return window;
}

export async function holderWindow(
  id: string,
  brand: BrandId,
  options: { folder?: string; arms?: readonly Arm[]; fake?: FakeOptions } = {}
): Promise<HolderWindow> {
  const folder = await canonical(options.folder ?? workFolder(id));
  const window = new HolderWindow(id, brand, folder, options.arms ?? [], options.fake ?? {});
  await window.open();
  return window;
}

/** Outside any repository, so a drain baselines no working tree. */
function workFolder(id: string): string {
  return path.join(os.homedir(), 'work', id);
}

/**
 * The folder as its own process resolves it. A temp `HOME` sits under a
 * symlink on macOS, and a CLI states the cwd its process resolved, so a claim
 * written with the short spelling holds none of that session's directories
 * (`src/test/AGENTS.md`, canonical paths).
 */
async function canonical(folder: string): Promise<string> {
  await fs.mkdir(folder, { recursive: true });
  return fs.realpath(folder);
}

export class TestWindow {
  readonly claim: WindowClaim;
  /** Every request this window's loop was handed, in order. */
  readonly served: Request[] = [];
  protected readonly entries = new Map<number, Entry>();
  private published: Promise<unknown> = Promise.resolve();
  private looping: Promise<void> = Promise.resolve();
  private readonly serving = new Set<Promise<void>>();
  private stopped = false;
  private gone = false;

  constructor(
    readonly id: string,
    readonly brand: BrandId,
    readonly folder: string,
    private readonly arms: readonly Arm[]
  ) {
    this.claim = {
      id,
      label: `window ${id}`,
      app: 'Code',
      folder,
      shellPids: [],
      updatedAt: Date.now()
    };
    windows.add(this);
  }

  async open(): Promise<void> {
    await fs.mkdir(WINDOWS_DIR, { recursive: true });
    await fs.writeFile(this.claimFile(), JSON.stringify(this.claim));
    this.looping = this.loop();
  }

  /**
   * A session started here as `startOwned` starts one: the brand's launch line,
   * a real child, published on every change. Resolves once the CLI has named
   * the session, so a parent's sessionId is there for its children.
   */
  async start(spawn: Spawn = {}): Promise<Live> {
    const brand = spawn.brand ?? this.brand;
    const cwd = spawn.cwd ?? this.folder;
    const cli = adapter(brand);
    if (!cli) throw new Error(`no adapter for ${brand}`);
    const minted = randomUUID();
    const { bin, env } = fixture(brand, minted);
    // Stated, as `startOwned` states the window's setting: Grok's launch
    // reads an absent one as its own default rather than as off.
    const line = cli.launch({
      bin: executables.named(bin, process.execPath),
      cwd,
      sessionId: minted,
      skipPermissions: false,
      model: spawn.model,
      window: spawn.window,
      effort: spawn.effort
    });
    const transport = childTransport({
      bin: line.bin,
      cwd,
      args: line.args,
      env: { ...line.env, ...env },
      terminateOnClose: line.terminateOnClose,
      windowId: this.id
    });
    const began = performance.now();
    const timeline: unknown[] = [];
    const trace = (event: string, detail?: unknown): void => {
      timeline.push({
        ms: Math.round(performance.now() - began),
        event,
        detail: JSON.stringify(detail, (_key, value: unknown) =>
          typeof value === 'string' ? value.replaceAll(os.homedir(), '<fixture-home>') : value
        )?.slice(0, 1500)
      });
      if (timeline.length > 64) timeline.shift();
    };
    trace('spawn', { brand, pid: transport.pid });
    const write = transport.write.bind(transport);
    transport.write = (value) => {
      trace('write', value);
      write(value);
    };
    transport.onLine((value) => trace('line', value));
    transport.onExit((info) => trace('exit', info));
    transport.onEnd?.(() => trace('output-end'));
    void transport.exited?.then((confirmed) => trace('native-exit', { confirmed }));
    const pid = transport.pid;
    if (pid === undefined) throw new Error('the fake CLI did not start');
    const startedAt = Date.now();
    const handle = cli.connect(transport, {
      cwd,
      startedAt,
      sessionId: minted,
      model: spawn.model,
      window: spawn.window,
      effort: spawn.effort,
      skipPermissions: false
    });
    const ready = await handle.opening;
    trace('opening', ready);
    if (ready && !ready.ok) throw new Error(ready.reason);
    const sessionId = await until(`${brand} names its session`, () => handle.state.sessionId);
    const addr = { pid, startedAt, windowId: this.id };
    const entry: Entry = {
      pid,
      startedAt,
      sessionId,
      brand,
      handle,
      addr,
      stop: () => {},
      trace,
      timeline
    };
    entry.stop = handle.onChange(() => {
      trace('state', this.turnState(handle));
      this.publish(entry);
    });
    this.entries.set(pid, entry);
    if (spawn.parent !== undefined) {
      await writeLineage(pid, {
        schema: 1,
        spawnedAt: startedAt,
        cwd,
        requestId: randomUUID(),
        parentSessionId: spawn.parent
      });
    }
    this.publish(entry);
    if (spawn.prompt !== undefined) await this.say(pid, spawn.prompt, spawn.correlation);
    return entry;
  }

  /** A person typing in this window's composer. */
  async say(pid: number, text: string, correlation?: string): Promise<void> {
    const entry = this.entries.get(pid);
    entry?.trace('send', { text, correlation });
    const messages = this.live(pid).handle.messages;
    if (!messages) throw new Error(`${this.brand} takes no messages`);
    await messages.send(text, undefined, undefined, undefined, undefined, correlation);
    entry?.trace('send-returned');
  }

  live(pid: number): Live {
    const entry = this.entries.get(pid);
    if (!entry) throw new Error(`window ${this.id} holds no pid ${pid}`);
    return entry;
  }

  /** Every pid this window holds, in the order it started them. */
  pids(): number[] {
    return [...this.entries.keys()];
  }

  holdsPid(pid: number): boolean {
    return this.entries.has(pid);
  }

  /** The card this window would draw, as the record other windows read. */
  session(pid: number): Session {
    return this.sessionOf(this.live(pid));
  }

  /** Waits for a session's live state to say what a test needs. */
  async until(
    pid: number,
    what: string,
    want: (live: SessionHandle['state']) => boolean
  ): Promise<void> {
    const { handle } = this.live(pid);
    const entry = this.entries.get(pid);
    let lastPoll = performance.now();
    let maxPollGapMs = 0;
    entry?.trace('wait-start', { what });
    try {
      await until(what, () => {
        const now = performance.now();
        maxPollGapMs = Math.max(maxPollGapMs, now - lastPoll);
        lastPoll = now;
        return want(handle.state) ? true : undefined;
      });
      entry?.trace('wait-done', { what, maxPollGapMs });
    } catch (error) {
      entry?.trace('wait-failed', { what, maxPollGapMs });
      throw new Error(`${String(error)}\n${JSON.stringify(this.evidence(pid))}`, { cause: error });
    }
  }

  evidence(pid: number): unknown {
    const entry = this.entries.get(pid);
    return {
      pid,
      brand: entry?.brand,
      state: entry && this.turnState(entry.handle),
      requests: this.served.slice(-8).map(({ kind }) => kind),
      timeline: entry?.timeline
    };
  }

  private turnState(handle: SessionHandle): unknown {
    const state = handle.state;
    return {
      turnsEnded: state.turnsEnded,
      running: state.running,
      queued: state.queued,
      pending: state.pending,
      exit: state.exit
    };
  }

  /** Every record written and every thread line on disk, so another window
   *  reads what this one holds. */
  async settled(): Promise<void> {
    for (const entry of this.entries.values()) await entry.handle.flush?.();
    await this.published;
  }

  /** End as the panel's End does: the child goes with its pipe. */
  end(pid: number, startedAt: number): boolean {
    const entry = this.entries.get(pid);
    if (!entry || !sameSessionStart(entry.startedAt, startedAt)) return false;
    this.drop(entry);
    return true;
  }

  servePort(): ServePort {
    return {
      owned: (pid) => this.entries.get(pid)?.handle,
      end: (pid, startedAt) => this.end(pid, startedAt),
      start: (start) => this.startFor(start),
      holder: async () => readHolder(await scanProcesses())
    };
  }

  /**
   * The window dies and leaves its children running: its loop stops and its
   * claim goes, and its records stay on disk naming live processes — what a
   * crashed extension host leaves for `core/control.ts` to reap.
   */
  async leave(): Promise<void> {
    this.gone = true;
    await this.stopLoop();
    await fs.rm(this.claimFile(), { force: true });
  }

  async dispose(): Promise<void> {
    windows.delete(this);
    await this.stopLoop();
    await fs.rm(this.claimFile(), { force: true });
    for (const entry of [...this.entries.values()]) this.drop(entry);
    await this.published;
  }

  protected async startFor(start: RemoteStart): Promise<Started> {
    if (this.gone) return { ok: false, reason: 'gone', outcome: 'stopped' };
    const resolved = listings.remoteTarget(start, (await this.models()).models, () => undefined);
    if (!resolved.ok) return resolved;
    if (start.selection !== undefined && path.resolve(start.cwd) !== path.resolve(this.folder)) {
      return { ok: false, reason: 'Choose again', outcome: 'stopped', selectionInvalid: true };
    }
    const live = await this.start({
      cwd: start.cwd,
      ...(start.prompt === undefined ? {} : { prompt: start.prompt }),
      ...(start.correlation === undefined ? {} : { correlation: start.correlation }),
      ...(start.brand === undefined ? {} : { brand: start.brand }),
      ...resolved.target
    });
    return {
      ok: true,
      pid: live.pid,
      startedAt: live.startedAt,
      brand: live.brand,
      sessionId: live.sessionId
    };
  }

  /** What `remoteBoard` reads off this window's handles. */
  protected own(): OwnSession[] {
    return [...this.entries.values()].map((entry) => {
      const state = entry.handle.state;
      return {
        session: this.sessionOf(entry),
        pending: state.pending,
        ...(state.messageFacts === undefined ? {} : { messageFacts: state.messageFacts }),
        ...(state.exit === undefined ? {} : { exit: state.exit })
      };
    });
  }

  private sessionOf(entry: Live): Session {
    return toSession(
      entry.handle.state,
      { pid: entry.pid, startedAt: entry.startedAt, updatedAt: Date.now(), brand: entry.brand },
      this.id
    );
  }

  private publish(entry: Entry): void {
    const state = entry.handle.state;
    this.published = publishLive({
      schema: 1,
      session: this.sessionOf(entry),
      pending: state.pending,
      ...(state.messageFacts === undefined ? {} : { messageFacts: state.messageFacts }),
      queued: state.queued.map(({ id, text, queuedAt }) => ({ id, text, queuedAt })),
      ...(state.exit === undefined ? {} : { exit: state.exit })
    });
  }

  private drop(entry: Entry): void {
    entry.trace('close-requested');
    entry.stop();
    entry.handle.close();
    this.entries.delete(entry.pid);
    this.published = removePublished(entry.pid);
  }

  models(): Promise<listings.RemoteModels> {
    const models = listings.modelListing([{ brand: this.brand }]);
    return Promise.resolve({ models, remoteSelection: { defaultTarget: {} } });
  }

  private async loop(): Promise<void> {
    const serve = (request: Request): Promise<Reply> => {
      this.served.push(request);
      for (const arm of this.arms) {
        const reply = arm(request);
        if (reply) return reply;
      }
      if (request.kind === 'models')
        return this.models().then((models) => ({ ok: true, ...models }));
      return (
        serveOwned(request, this.servePort()) ??
        Promise.resolve({ ok: false, reason: `This window does not serve ${request.kind}.` })
      );
    };
    while (!this.stopped) {
      const scan = claimRequests(this.id, serve);
      this.serving.add(scan);
      void scan.finally(() => this.serving.delete(scan)).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, LOOP_MS));
    }
  }

  private async stopLoop(): Promise<void> {
    this.stopped = true;
    await this.looping;
    await Promise.allSettled([...this.serving]);
  }

  protected unclaim(): Promise<void> {
    return fs.rm(this.claimFile(), { force: true });
  }

  private claimFile(): string {
    return path.join(WINDOWS_DIR, `${this.id}.json`);
  }
}

/**
 * The window that holds Remote: `RemoteSwitch`, the class `RemoteHost` runs,
 * over this window's handles, the fake messenger and the real holder file.
 * Its Reconciler tenant runs nothing on its own; a test calls `pass()`.
 */
export class HolderWindow extends TestWindow {
  /** One account at the messenger for this window's life: a turn-off and
   *  turn-on reconnect to the same conversations, as a real one does. */
  readonly messenger: FakeMessenger;
  /** What the switch and the engine logged. */
  readonly logs: string[] = [];
  /** The remembered switch, as the host's memory file would hold it. */
  memory: string | undefined;
  readonly remote: RemoteSwitch;
  /**
   * This window's extension host, as a process of its own. The holder file
   * names a host by pid and start time, and every window here shares the
   * test's one process, so each holder window needs a separate native PID.
   */
  private host: Awaited<ReturnType<typeof heldProcess>> | undefined;
  private readonly guard = new AttachGuard();

  constructor(id: string, brand: BrandId, folder: string, arms: readonly Arm[], fake: FakeOptions) {
    super(id, brand, folder, arms);
    this.messenger = fakeMessenger({ ...fake, credentials: { token: SENTINEL } });
    this.remote = new RemoteSwitch(this.switchPort());
  }

  holds(): boolean {
    return this.remote.holds();
  }

  turnOn(): Promise<TurnedOn> {
    return this.remote.turnOn();
  }

  turnOff(): Promise<void> {
    return this.remote.turnOff();
  }

  /** One pass, on the chain every pass shares. */
  pass(): Promise<void> {
    return this.remote.pass(true);
  }

  /** Every event the messenger has delivered, handled, and nothing observed:
   *  a pass would also post what the board did meanwhile. */
  drain(): Promise<void> {
    return this.remote.tick();
  }

  attach(addr: SessionAddr, attachment: Attachment): Promise<Attached> {
    return this.remote.attach(addr, attachment);
  }

  attachTarget(addr: SessionAddr): Promise<Target> {
    return this.remote.attachTarget(addr);
  }

  /** `serveAttach`'s port as `host/extension.ts` builds it over `RemoteHost`:
   *  one guard for the window's life, and Squadron's state never sent (a test
   *  host has no user-data directory to add). */
  attachPort(): AttachPort {
    return {
      holds: () => this.holds(),
      guard: this.guard,
      target: (addr) => this.attachTarget(addr),
      attach: (addr, attachment) => this.attach(addr, attachment),
      deny: [STATE_DIR]
    };
  }

  /** The host's close order: the claim goes once Remote has released. */
  override async dispose(): Promise<void> {
    await unclaimAfter(this.remote.dispose(), () => void this.unclaim());
    await this.host?.stop();
    await super.dispose();
  }

  /**
   * The ports as a host fills them, over this window. Every process table is
   * fresh: the host's scheduled pass may reuse one `CACHE_MS` old, and a test
   * reads the board each pass builds at once. Every window's records and
   * threads are on disk before a pass reads them: a host's pass reads whatever
   * is there, and a test asserts on one pass.
   */
  private switchPort(): SwitchPort {
    return {
      windowId: this.id,
      entry: () => fakeEntry,
      allowlist: () => [OWNER],
      credentials: () => Promise.resolve(this.messenger.credentials),
      messenger: () => Promise.resolve({ ok: true, messenger: this.messenger }),
      identity: () => this.identity(),
      own: () => this.own(),
      sessions: {
        owned: (pid) => this.servePort().owned(pid),
        end: (pid, at) => this.end(pid, at),
        start: (start) => this.startFor(start),
        models: () => this.models()
      },
      processes: () => scanProcesses(true),
      published: async () => {
        for (const window of windows) await window.settled();
        return readPublished();
      },
      lineage: () => readLineage(),
      claims: () => readClaims(),
      memory: {
        read: () => Promise.resolve(this.memory),
        write: (text) => {
          this.memory = text;
        }
      },
      keeper: {
        requestCheck: () => undefined,
        reason: () => undefined,
        holdsForRemote: () => true
      },
      register: () => ({
        noticeChange: () => undefined,
        requestCheck: () => undefined,
        schedule: () => undefined,
        dispose: () => undefined
      }),
      clock: Date.now,
      log: (line) => this.logs.push(line),
      changed: () => undefined
    };
  }

  private async identity(): Promise<Holder | undefined> {
    this.host ??= await heldProcess();
    const pid = this.host.child.pid;
    if (pid === undefined) return undefined;
    const table = await until('the host in the process table', async () => {
      const fresh = await scanProcesses(true);
      if (fresh.unavailable) throw new Error(fresh.unavailable);
      return fresh.starts.has(pid) ? fresh : undefined;
    });
    return {
      windowId: this.id,
      label: this.claim.label,
      folder: this.folder,
      pid,
      startedAt: table.starts.get(pid) ?? 0,
      since: Date.now()
    };
  }
}

/** The first answer `read` gives, polled every 20 ms (an interval) for up to
 *  `ms` (a duration), or a failure naming what was waited for. */
export async function until<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
  ms = 5_000
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
