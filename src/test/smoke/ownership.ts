import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';
import * as platform from '../../core/platform';
import type * as processes from '../../core/platform/processes';
import * as darwinProcesses from '../../core/platform/processes/darwin';
import * as scan from '../../core/scan';
import { testPlatform } from '../helpers';

/** `pgid` is absent where the OS has no process groups (win32), never the pid. */
export type ProcessIdentity = {
  pid: number;
  ppid: number;
  pgid?: number;
  startedAt: number;
  command?: string;
  /** The image file name where the OS reports one (win32 `Code.exe`). */
  image?: string;
};
export type ProcessSnapshot = Map<number, ProcessIdentity>;
export type LaunchOwnership = {
  id: string;
  root: ProcessIdentity;
  members: ProcessSnapshot;
  /**
   * Rows reached only through a member that was gone or reused when they were
   * read, and their descendants, keyed by `suspectKey`. Never signalled: a
   * survivor is reported, because a reuser that lived and died between two
   * reads would leave its own orphans on the dead member's pid.
   */
  suspects: Map<string, ProcessIdentity>;
  groups: boolean;
  closed: boolean;
  cleaning?: Promise<void>;
};
export type CleanupPorts = {
  read: () => Promise<ProcessSnapshot>;
  /** Ends `member`, which `rows` (a fresh read) still shows at its witnessed
   *  start; `group` asks for the group it leads. Throws on a refusal. */
  signal: (
    member: ProcessIdentity,
    signal: NodeJS.Signals,
    group: boolean,
    rows: ProcessSnapshot
  ) => void;
  pause: () => Promise<void>;
  now: () => number;
  /** Whether the OS can ask a process to finish before killing it. */
  graceful?: boolean;
};

const run = util.promisify(childProcess.execFile);
export const SCAN_MS = 2000;
export const TERM_MS = 2000;
export const CLEANUP_MS = 8000;
export const REQUEST_MS = 15_000;

export async function readProcesses(): Promise<ProcessSnapshot> {
  return testPlatform() === 'win32' ? readWindows() : readPs();
}

/** Only a complete table can say a member is gone: an incomplete one retains it. */
async function readWindows(): Promise<ProcessSnapshot> {
  const snapshot = await platform.processes.snapshot();
  if (!snapshot.supported) throw new Error(`process scan unavailable: ${snapshot.reason}`);
  if (snapshot.status !== 'ok')
    throw new Error(`process scan ${snapshot.status}: ${snapshot.reason}`);
  if (snapshot.value.source !== WIN32_SOURCE)
    throw new Error(`unexpected start source ${snapshot.value.source}`);
  const rows: ProcessSnapshot = new Map();
  for (const row of snapshot.value.rows) {
    rows.set(row.pid, {
      pid: row.pid,
      ppid: row.ppid,
      startedAt: row.startedAt,
      ...(row.command === null ? {} : { command: row.command }),
      ...(row.image === undefined ? {} : { image: row.image })
    });
  }
  if (!rows.has(process.pid)) throw new Error('process scan omitted its reader');
  return rows;
}

const WIN32_SOURCE = 'win32-filetime-ms-v1';

async function readPs(): Promise<ProcessSnapshot> {
  const { stdout } = await run('/bin/ps', ['-Ao', 'stat=,pid=,ppid=,pgid=,lstart=,command='], {
    timeout: SCAN_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  });
  const rows: ProcessSnapshot = new Map();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\S+)\s+(.*)$/.exec(line);
    const row = darwinProcesses.parseRow(match?.[2] ?? '');
    if (!row || !Number.isFinite(row.startedAt) || row.pid <= 0) {
      throw new Error(`ambiguous process row: ${line}`);
    }
    if (!match?.[1]?.startsWith('Z')) rows.set(row.pid, row);
  }
  if (!rows.has(process.pid)) throw new Error('process scan omitted its reader');
  return rows;
}

const posixPorts: CleanupPorts = {
  read: readProcesses,
  signal: (member, signal, group) => {
    try {
      process.kill(group ? -member.pid : member.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  },
  pause: () => new Promise((resolve) => setTimeout(resolve, 50)),
  now: () => performance.now(),
  graceful: true
};

/**
 * win32 has no request a process can act on and no group: every member is
 * killed alone, through the capability's start-checked `TerminateProcess`.
 */
const win32Ports: CleanupPorts = {
  ...posixPorts,
  signal: (member, _signal, _group, rows) => {
    const [outcome] = platform.processes.signal(
      [{ pid: member.pid, startedAt: member.startedAt }],
      'kill',
      evidenceOf(rows)
    );
    if (outcome === 'sent' || outcome === 'absent') return;
    throw new Error(
      `kill ${member.pid} ${outcome === 'refused' ? 'refused' : `unsupported: ${outcome?.reason}`}`
    );
  },
  graceful: false
};

function livePorts(): CleanupPorts {
  return testPlatform() === 'win32' ? win32Ports : posixPorts;
}

function evidenceOf(rows: ProcessSnapshot): processes.Evidence {
  return {
    complete: true,
    startSource: WIN32_SOURCE,
    starts: new Map([...rows].map(([pid, row]) => [pid, row.startedAt])),
    groups: new Map()
  };
}

/**
 * pid -> ppid, without an edge whose parent row is younger than its child:
 * that parent is a reused pid, as `scan.tableOf` refutes it. win32 keeps a
 * dead parent's pid in its children's rows, so this is what stops a later
 * process on that pid from adopting them.
 */
export function parentsOf(rows: ProcessSnapshot): Map<number, number | undefined> {
  return new Map(
    [...rows].map(([pid, row]) => {
      const parent = rows.get(row.ppid);
      return [pid, parent && parent.startedAt > row.startedAt ? undefined : row.ppid];
    })
  );
}

export function ownLaunch(id: string, root: ProcessIdentity): LaunchOwnership {
  if (root.pid <= 1 || !Number.isFinite(root.startedAt)) throw new Error('invalid launch identity');
  return {
    id,
    root,
    members: new Map([[root.pid, root]]),
    suspects: new Map(),
    groups: root.pgid !== undefined,
    closed: false
  };
}

function same(a: ProcessIdentity | undefined, b: ProcessIdentity): boolean {
  return a?.startedAt === b.startedAt && a.pgid === b.pgid;
}

export function observeLaunch(launch: LaunchOwnership, rows: ProcessSnapshot): void {
  const parents = parentsOf(rows);
  const known = (row: ProcessIdentity): boolean =>
    launch.members.get(row.pid)?.startedAt === row.startedAt ||
    launch.suspects.has(suspectKey(row));
  const tree = (pid: number): ProcessIdentity[] =>
    [pid, ...scan.descendants(pid, parents)].flatMap((each) => rows.get(each) ?? []);
  const adopt = (pid: number): void => {
    for (const row of tree(pid)) {
      if (!launch.members.has(row.pid) && !known(row)) launch.members.set(row.pid, row);
    }
  };
  const suspect = (pid: number): void => {
    const row = rows.get(pid);
    if (!row || launch.members.get(pid)?.startedAt === row.startedAt) return;
    for (const row of tree(pid)) {
      if (!known(row)) launch.suspects.set(suspectKey(row), row);
    }
  };
  const gone: ProcessIdentity[] = [];
  for (const member of [...launch.members.values()]) {
    const current = rows.get(member.pid);
    if (!same(current, member)) {
      if (current?.startedAt !== member.startedAt) gone.push(member);
      continue;
    }
    adopt(member.pid);
    if (launch.groups && member.pgid === member.pid) {
      for (const row of rows.values()) {
        if (row.pgid === member.pid && !launch.members.has(row.pid))
          launch.members.set(row.pid, row);
      }
    }
  }
  // After every live edge, so a member's own subtree stays owned.
  for (const member of gone) orphansOf(member, rows).forEach(suspect);
  // A suspect's own children are suspects too, through a live edge or its pid.
  for (const each of [...launch.suspects.values()]) {
    if (rows.get(each.pid)?.startedAt === each.startedAt) suspect(each.pid);
    else orphansOf(each, rows).forEach(suspect);
  }
}

/**
 * Rows still naming `gone`'s pid as their parent that started after it and
 * before any reuse of that pid. win32 leaves a dead pid in its children's rows,
 * so these are its children or the orphans of a reuser that lived and died
 * between two reads; nothing here tells the two apart.
 */
function orphansOf(gone: ProcessIdentity, rows: ProcessSnapshot): number[] {
  const current = rows.get(gone.pid);
  return [...rows.values()]
    .filter(
      (row) =>
        row.ppid === gone.pid &&
        row.startedAt >= gone.startedAt &&
        !(current && current.startedAt <= row.startedAt)
    )
    .map((row) => row.pid);
}

function suspectKey(row: ProcessIdentity): string {
  return `${row.pid}@${row.startedAt}`;
}

function survivors(launch: LaunchOwnership, rows: ProcessSnapshot): ProcessIdentity[] {
  const alive: ProcessIdentity[] = [];
  for (const member of launch.members.values()) {
    const current = rows.get(member.pid);
    if (!current || current.startedAt !== member.startedAt) continue;
    if (current.pgid !== member.pgid) continue;
    alive.push(member);
  }
  return alive;
}

function survivingSuspects(launch: LaunchOwnership, rows: ProcessSnapshot): ProcessIdentity[] {
  return [...launch.suspects.values()].filter(
    (each) => rows.get(each.pid)?.startedAt === each.startedAt
  );
}

export function cleanupLaunch(
  launch: LaunchOwnership,
  ports: CleanupPorts = livePorts()
): Promise<void> {
  if (launch.cleaning) return launch.cleaning;
  if (launch.closed) return Promise.resolve();
  const work = reap(launch, ports);
  launch.cleaning = work;
  void work.then(
    () => {
      launch.cleaning = undefined;
    },
    () => {
      launch.cleaning = undefined;
    }
  );
  return work;
}

function unwitnessedGroupMembers(launch: LaunchOwnership, rows: ProcessSnapshot): number[] {
  if (!launch.groups) return [];
  const departedGroups = new Set(
    [...launch.members.values()]
      .filter((member) => member.pid === member.pgid && !rows.has(member.pid))
      .map((member) => member.pgid)
  );
  return [...rows.values()]
    .filter(
      (row) =>
        departedGroups.has(row.pgid) && launch.members.get(row.pid)?.startedAt !== row.startedAt
    )
    .map((row) => row.pid);
}

async function reap(launch: LaunchOwnership, ports: CleanupPorts): Promise<void> {
  const began = ports.now();
  let rounds = 0;
  for (;;) {
    const rows = await ports.read();
    observeLaunch(launch, rows);
    const alive = survivors(launch, rows);
    const changed = [...launch.members.values()].filter((member) => {
      const current = rows.get(member.pid);
      return current?.startedAt === member.startedAt && current.pgid !== member.pgid;
    });
    const unknown = [...unwitnessedGroupMembers(launch, rows), ...changed.map((p) => p.pid)];
    const suspects = survivingSuspects(launch, rows);
    if (!alive.length && !unknown.length && !suspects.length) {
      launch.closed = true;
      return;
    }
    // A suspect is waited for, as an owned process's helper exits with it, but
    // never signalled: the operator decides one that outlives the budget.
    if (ports.now() - began >= CLEANUP_MS || rounds++ >= 100) {
      const owned = [...alive.map((p) => p.pid), ...unknown];
      throw new Error(
        [
          owned.length &&
            `owned or unwitnessed group processes survived cleanup: ${owned.join(',')}`,
          suspects.length &&
            `unwitnessed descendants of a dead member survived cleanup: ${suspects
              .map((p) => `${suspectKey(p)}${p.image ? ` ${p.image}` : ''}`)
              .join(',')}`
        ]
          .filter(Boolean)
          .join('; ')
      );
    }
    const signal = ports.graceful && ports.now() - began < TERM_MS ? 'SIGTERM' : 'SIGKILL';
    const signalErrors: unknown[] = [];
    const signalledGroups = new Set<number>();
    alive.sort((a, b) => Number(b.pid === b.pgid) - Number(a.pid === a.pgid));
    for (const member of alive) {
      if (member.pgid !== undefined && signalledGroups.has(member.pgid)) continue;
      if (ports.now() - began >= CLEANUP_MS) throw new Error('cleanup deadline before signal');
      const fresh = await ports.read();
      const current = fresh.get(member.pid);
      if (!current || current.startedAt !== member.startedAt) continue;
      if (!same(current, member)) continue;
      if (ports.now() - began >= CLEANUP_MS) throw new Error('cleanup deadline before signal');
      // An exited leader is not authority to signal a possibly reused group.
      const group = launch.groups && member.pid === member.pgid;
      try {
        ports.signal(member, signal, group, fresh);
        if (group) signalledGroups.add(member.pid);
      } catch (error) {
        signalErrors.push(error);
      }
    }
    if (signalErrors.length)
      throw new Error(`smoke signals failed: ${signalErrors.map(String).join('; ')}`);
    await ports.pause();
  }
}

export type RunPaths = {
  root: string;
  home: string;
  profile: string;
  seed: string;
  socket: string;
};
type Reply = { ok: boolean; value?: unknown; error?: string };
type Message = {
  token: string;
  type: 'worker' | 'allocate' | 'register' | 'prepare' | 'finish' | 'release';
  pid: number;
  launch?: string;
  helper?: number;
};
export type Supervisor = {
  paths: RunPaths;
  token: string;
  worker?: ProcessIdentity;
  launches: Map<string, LaunchOwnership | undefined>;
  onLoss: () => void;
  onRelease: () => void;
  closing: boolean;
  shutdown: () => Promise<void>;
};

/**
 * win32's launch root is Playwright's cmd.exe, which starts the IDE only once
 * the registering helper has exited, and which exits with a killed worker
 * while that IDE lives on (observed 2026-10-27, tooling Step 5 Notes). A child
 * reached only through the dead root is a suspect, never owned, so the root is
 * watched from registration until a child started after the helper is owned
 * through its live edge, the root is gone, or shutdown begins. Bounded by
 * `REQUEST_MS`; a failed read leaves the judgement to cleanup's own reads.
 */
async function witnessStart(
  launch: LaunchOwnership,
  helper: number,
  closing: () => boolean
): Promise<void> {
  const after = launch.members.get(helper)?.startedAt ?? launch.root.startedAt;
  const deadline = performance.now() + REQUEST_MS;
  try {
    while (!closing() && !launch.closed && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (closing()) return;
      const rows = await readProcesses();
      observeLaunch(launch, rows);
      if (!same(rows.get(launch.root.pid), launch.root)) return;
      const started = [...launch.members.values()].some(
        (member) =>
          member.ppid === launch.root.pid &&
          member.pid !== helper &&
          member.startedAt > after &&
          same(rows.get(member.pid), member)
      );
      if (started) return;
    }
  } catch {
    /* judged by cleanup's own reads */
  }
}

export async function createSupervisor(root?: string): Promise<Supervisor> {
  const windows = testPlatform() === 'win32';
  const made =
    root ??
    (windows
      ? await fs.mkdtemp(path.join(os.tmpdir(), 'sq-smoke-'))
      : // eslint-disable-next-line squadron/temp-root -- control.sock must pass the socket path check below
        await fs.mkdtemp('/tmp/sq-smoke-'));
  if (root) await fs.mkdir(root, { mode: 0o700 });
  const canonical = await fs.realpath(made);
  const paths = {
    root: canonical,
    home: path.join(canonical, 'home'),
    profile: path.join(canonical, 'profile'),
    seed: path.join(canonical, 'seed'),
    // win32 has no Unix socket; a pipe name is outside the run root, and
    // the token is what admits a client.
    socket: windows
      ? `\\\\.\\pipe\\sq-smoke-${crypto.randomUUID()}`
      : path.join(canonical, 'control.sock')
  };
  if (Buffer.byteLength(paths.socket) > 100) throw new Error('smoke socket path exceeds 100 bytes');
  const sockets = new Set<net.Socket>();
  const pending = new Set<Promise<void>>();
  const retired = new Set<string>();
  let lifetime: net.Socket | undefined;
  let released = false;
  const supervisor: Supervisor = {
    paths,
    token: crypto.randomUUID(),
    launches: new Map(),
    onLoss: () => undefined,
    onRelease: () => undefined,
    closing: false,
    shutdown: async () => {
      supervisor.closing = true;
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled(
        [...supervisor.launches.values()].map(async (launch) => {
          if (launch) await cleanupLaunch(launch);
        })
      );
      released = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const errors = results.filter((r) => r.status === 'rejected');
      if (errors.length)
        throw new AggregateError(
          errors.map((r): unknown => r.reason),
          'smoke cleanup uncertain'
        );
    }
  };
  const handle = async (message: Message, socket: net.Socket): Promise<unknown> => {
    if (
      message.token !== supervisor.token ||
      !Number.isSafeInteger(message.pid) ||
      message.pid <= 1
    ) {
      throw new Error('invalid smoke credentials');
    }
    if (supervisor.closing) throw new Error('smoke supervisor is shutting down');
    if (message.type === 'worker') {
      if (lifetime) throw new Error('smoke worker already connected');
      const rows = await readProcesses();
      const worker = rows.get(message.pid);
      const parents = parentsOf(rows);
      if (
        !worker ||
        lifetime ||
        socket.destroyed ||
        !scan.descendants(process.pid, parents).includes(worker.pid) ||
        supervisor.closing
      ) {
        throw new Error('worker is not a live supervisor descendant');
      }
      supervisor.worker = worker;
      lifetime = socket;
      socket.once('close', () => {
        if (!released) {
          supervisor.closing = true;
          supervisor.onLoss();
        }
      });
      return paths;
    }
    const worker = supervisor.worker;
    if (!worker || !lifetime || lifetime.destroyed)
      throw new Error('smoke worker is not connected');
    if (message.type === 'register') {
      if (
        !message.launch ||
        !supervisor.launches.has(message.launch) ||
        supervisor.launches.get(message.launch)
      ) {
        throw new Error('unknown or already registered launch');
      }
      const rows = await readProcesses();
      const root = rows.get(message.pid);
      const parents = parentsOf(rows);
      // win32's root is Playwright's cmd.exe, and there is no group to lead.
      if (
        !root ||
        !same(rows.get(worker.pid), worker) ||
        (root.pgid !== undefined && root.pgid !== root.pid) ||
        (root.pgid === undefined && !windows) ||
        parents.get(message.helper ?? 0) !== root.pid ||
        !scan.descendants(worker.pid, parents).includes(root.pid)
      ) {
        throw new Error('launcher ancestry or isolated group not verified');
      }
      if (
        supervisor.closing ||
        lifetime.destroyed ||
        !supervisor.launches.has(message.launch) ||
        supervisor.launches.get(message.launch)
      ) {
        throw new Error('worker lost or duplicate registration during launch');
      }
      const launch = ownLaunch(message.launch, root);
      observeLaunch(launch, rows);
      supervisor.launches.set(launch.id, launch);
      if (windows) {
        const watching = witnessStart(launch, message.helper ?? 0, () => supervisor.closing);
        pending.add(watching);
        void watching.finally(() => pending.delete(watching));
      }
      return root;
    }
    if (message.pid !== worker.pid) throw new Error('message is not from this worker');
    if (message.type === 'allocate') {
      const id = crypto.randomUUID();
      supervisor.launches.set(id, undefined);
      return id;
    }
    if (message.type === 'release') {
      released = true;
      supervisor.closing = true;
      return null;
    }
    const id = message.launch ?? '';
    if (retired.has(id)) return null;
    const launch = supervisor.launches.get(id);
    if (!launch && supervisor.launches.has(id)) {
      supervisor.launches.delete(id);
      retired.add(id);
      return null;
    }
    if (!launch) throw new Error('unknown launch identity');
    if (message.type === 'prepare') {
      observeLaunch(launch, await readProcesses());
      return null;
    }
    await cleanupLaunch(launch);
    return null;
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    let input = '';
    socket.setTimeout(REQUEST_MS, () => {
      if (socket !== lifetime) socket.destroy();
    });
    socket.on('data', (chunk: Buffer) => {
      input += chunk.toString();
      if (input.length > 4096) {
        socket.destroy();
        return;
      }
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      const work = (async () => {
        let reply: Reply;
        let release = false;
        try {
          const value = JSON.parse(input.split('\n')[0] ?? '') as Message;
          if (
            !['worker', 'allocate', 'register', 'prepare', 'finish', 'release'].includes(value.type)
          ) {
            throw new Error('invalid smoke message');
          }
          reply = { ok: true, value: await handle(value, socket) };
          release = value.type === 'release';
        } catch (error) {
          reply = { ok: false, error: String(error) };
        }
        if (socket === lifetime) socket.write(JSON.stringify(reply) + '\n');
        else
          socket.end(JSON.stringify(reply) + '\n', () => {
            if (release) supervisor.onRelease();
          });
      })();
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => {
          pending.delete(work);
          socket.destroy();
        }
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return supervisor;
}

export async function request(
  socketPath: string,
  message: Message,
  hold = false
): Promise<{ value: unknown; socket: net.Socket }> {
  const socket = net.createConnection(socketPath);
  return new Promise((resolve, reject) => {
    let input = '';
    const timer = setTimeout(() => fail(new Error('smoke acknowledgement timed out')), REQUEST_MS);
    const fail = (error: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.on('error', fail);
    socket.once('close', () => {
      clearTimeout(timer);
      reject(new Error('smoke control closed before acknowledgement'));
    });
    socket.once('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', (chunk: Buffer) => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      try {
        const reply = JSON.parse(input.split('\n')[0] ?? '') as Reply;
        if (reply.ok !== true) {
          fail(new Error(reply.error ?? 'smoke request refused'));
          return;
        }
        clearTimeout(timer);
        socket.removeAllListeners('data');
        if (!hold) socket.end();
        resolve({ value: reply.value, socket });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export type WorkerConnection = {
  paths: RunPaths;
  allocate: () => Promise<string>;
  prepare: (launch: string) => Promise<void>;
  finish: (launch: string) => Promise<void>;
  release: () => Promise<void>;
};
export async function connectWorker(
  env: NodeJS.ProcessEnv = process.env
): Promise<WorkerConnection> {
  const socketPath = env['SQUADRON_SMOKE_SOCKET'];
  const token = env['SQUADRON_SMOKE_TOKEN'];
  if (!socketPath || !token)
    throw new Error('smoke worker requires supervision; use npm run test:smoke[:one]');
  const send = (type: Message['type'], launch?: string) =>
    request(socketPath, { type, token, pid: process.pid, launch });
  const { value, socket } = await request(
    socketPath,
    { type: 'worker', token, pid: process.pid },
    true
  );
  // Playwright 1.61.1 closes Electron on SIGTERM but leaves Node alive (2026-10-09).
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (testPlatform() === 'win32') signals.push('SIGBREAK');
  const handlers = signals.map((signal) => {
    const handler = (): void => {
      socket.destroy();
      process.exit(128 + os.constants.signals[signal]);
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  const detach = (): void => {
    for (const { signal, handler } of handlers) process.removeListener(signal, handler);
  };
  socket.once('close', detach);
  const paths = value as RunPaths;
  if (!paths || typeof paths.root !== 'string' || typeof paths.home !== 'string') {
    socket.destroy();
    throw new Error('invalid supervisor paths');
  }
  return {
    paths,
    allocate: async () => {
      const reply = await send('allocate');
      if (typeof reply.value !== 'string') throw new Error('invalid launch id');
      return reply.value;
    },
    prepare: async (launch) => {
      await send('prepare', launch);
    },
    finish: async (launch) => {
      await send('finish', launch);
    },
    release: async () => {
      try {
        await send('release');
      } finally {
        detach();
        socket.destroy();
      }
    }
  };
}

export function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}
