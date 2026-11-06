import * as platform from './platform';
import { isBrand } from './brands';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExecutionRequest } from './checkpoint';
import type { BrandId } from './model';
import type { ShellFamily } from './platform/commands';
import * as identity from './identity';
import * as paths from './paths';
import * as scan from './scan';

export type ExecutionRuntime = {
  runtime: string;
  enabled: boolean;
  contextFile?: string;
  runner?: string;
};
export type ExecutionAdmission = {
  version: 1;
  runtime: string;
  brand: BrandId;
  enabled: boolean;
  sessionId: string;
  owner: string;
  turn: string;
};
export type ExecutionChild = { actor: string; parent: string; turn: string; ended?: number };
export type ExecutionDecoded = {
  request?: ExecutionRequest;
  child?: Pick<ExecutionChild, 'actor' | 'parent'> & { ended?: true };
};

export function executionChildFor(
  children: readonly ExecutionChild[],
  root: string,
  actor: string
): ExecutionChild | undefined {
  const child = children.find((value) => value.actor === actor);
  let parent = child?.parent;
  const visited = new Set<string>([actor]);
  while (parent && !visited.has(parent)) {
    if (parent === root) return child;
    visited.add(parent);
    parent = children.find((value) => value.actor === parent)?.parent;
  }
  return undefined;
}
export type ExecutionIntegration = {
  /** The shell this CLI runs a hook command in. */
  readonly hookShell: ShellFamily;
  configure(command: string, directory: string): Promise<unknown>;
  decode(
    payload: unknown,
    admission: ExecutionAdmission,
    children: readonly ExecutionChild[]
  ): ExecutionDecoded | undefined;
};

export async function prepareExecution(
  integration: ExecutionIntegration | undefined,
  source: string,
  enabled: boolean
): Promise<{
  runtime: ExecutionRuntime;
  configuration?: unknown;
  env?: Readonly<Record<string, string>>;
}> {
  const runtime: ExecutionRuntime = { runtime: crypto.randomUUID(), enabled: false };
  if (!enabled || !integration) return { runtime };
  try {
    const bundle = await fs.readFile(source);
    const digest = crypto.createHash('sha256').update(bundle).digest('hex');
    const directory = path.join(paths.STATE_DIR, 'execution', runtime.runtime);
    const runners = path.join(paths.STATE_DIR, 'execution', 'runners');
    await fs.mkdir(runners, { recursive: true });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const runner = path.join(runners, `${digest}.js`);
    const host: ExecutionHost = {
      version: 1,
      pid: process.pid,
      startedAt: Date.now() - process.uptime() * 1000
    };
    await fs.writeFile(path.join(directory, HOST_FILE), JSON.stringify(host), { mode: 0o600 });
    const temporaryRunner = path.join(directory, 'runner.next');
    await fs.writeFile(temporaryRunner, bundle, { flag: 'wx', mode: 0o600 });
    try {
      await fs.link(temporaryRunner, runner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const now = new Date();
      await fs.utimes(runner, now, now);
    } finally {
      await fs.rm(temporaryRunner, { force: true });
    }
    runtime.contextFile = path.join(directory, 'context.json');
    runtime.runner = runner;
    runtime.enabled = true;
    const target = platform.launchers.scriptCommand();
    const configuration = await integration.configure(
      platform.commands.render(
        target.program,
        [runner],
        { program: target.quoting, args: 'quoted' },
        platform.commands.shell(integration.hookShell),
        target.env
      ),
      directory
    );
    return {
      runtime,
      configuration,
      env: { [identity.EXECUTION_CONTEXT_ENV]: runtime.contextFile }
    };
  } catch {
    runtime.enabled = false;
    return { runtime };
  }
}

export const HOST_FILE = 'host.json';
/** Which extension host owns a runtime directory, for activation's orphan sweep. */
export type ExecutionHost = { version: 1; pid: number; startedAt: number };

export async function readExecutionHost(directory: string): Promise<ExecutionHost | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(directory, HOST_FILE), 'utf8'));
    if (!value || typeof value !== 'object') return undefined;
    const row = value as Record<string, unknown>;
    return row.version === 1 &&
      Number.isInteger(row.pid) &&
      (row.pid as number) > 0 &&
      typeof row.startedAt === 'number' &&
      Number.isFinite(row.startedAt)
      ? (row as ExecutionHost)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the recorded host still runs: its pid with a `ps` start time inside
 * the tolerance, so a reused pid reads as dead. `lstart` truncates to the
 * second and `process.uptime()` starts after the host's own bootstrap. A
 * table without this process in it could not be read, and answers alive.
 */
export async function executionHostAlive(
  host: ExecutionHost,
  table?: scan.ProcessTable
): Promise<boolean> {
  table ??= await scan.scanProcesses(true);
  if (!table.starts.has(process.pid)) return true;
  const started = table.starts.get(host.pid);
  return started !== undefined && Math.abs(started - host.startedAt) <= 5_000;
}

/**
 * Runtimes whose recorded host is gone, for activation to end. A directory
 * without a readable record is not listed: nothing proves its host dead.
 */
export async function orphanedRuntimes(
  root: string = path.join(paths.STATE_DIR, 'execution')
): Promise<{ runtime: string; contextFile: string }[]> {
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const table = await scan.scanProcesses(true);
  const orphans: { runtime: string; contextFile: string }[] = [];
  for (const name of names) {
    if (name === 'runners') continue;
    const directory = path.join(root, name);
    const contextFile = path.join(directory, 'context.json');
    const host = await readExecutionHost(directory);
    if (!host || (await executionHostAlive(host, table))) continue;
    try {
      await fs.access(contextFile);
      orphans.push({ runtime: name, contextFile });
    } catch {
      /* Never admitted a turn, so no hook could have registered a tree. */
    }
  }
  return orphans;
}

const admissionWrites = new WeakMap<ExecutionRuntime, Promise<boolean>>();

export function admitExecution(
  runtime: ExecutionRuntime,
  brand: BrandId,
  sessionId: string,
  turn: string
): Promise<boolean> {
  return publishAdmission(runtime, async () => {
    // core/prune.ts removes a runner a week past its last touch; every turn is a use.
    if (runtime.runner) {
      const now = new Date();
      await fs.utimes(runtime.runner, now, now).catch(() => undefined);
    }
    return {
      version: 1,
      runtime: runtime.runtime,
      brand,
      enabled: runtime.enabled,
      sessionId,
      owner: identity.conversationKey(brand, sessionId),
      turn
    };
  });
}

export function setExecutionEnabled(runtime: ExecutionRuntime, enabled: boolean): Promise<boolean> {
  runtime.enabled = enabled;
  return publishAdmission(runtime, async () => {
    const current = runtime.contextFile && (await readAdmission(runtime.contextFile));
    return current ? { ...current, enabled: runtime.enabled } : undefined;
  });
}

export async function flushAdmission(runtime: ExecutionRuntime): Promise<void> {
  let current: Promise<boolean> | undefined;
  do {
    current = admissionWrites.get(runtime);
    await current;
  } while (current !== admissionWrites.get(runtime));
}

function publishAdmission(
  runtime: ExecutionRuntime,
  current: () => Promise<ExecutionAdmission | undefined>
): Promise<boolean> {
  const written = (admissionWrites.get(runtime) ?? Promise.resolve(false))
    .then(async () => {
      if (!runtime.contextFile) return false;
      const admission = await current();
      if (!admission) return false;
      const temporary = `${runtime.contextFile}.next`;
      await fs.writeFile(temporary, JSON.stringify(admission), { mode: 0o600 });
      await platform.files.replace(temporary, runtime.contextFile);
      return runtime.enabled;
    })
    .catch(() => false);
  admissionWrites.set(runtime, written);
  return written;
}

export async function readAdmission(file: string): Promise<ExecutionAdmission | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || typeof value !== 'object') return undefined;
    const row = value as Record<string, unknown>;
    if (row.version !== 1 || !isBrand(row.brand) || typeof row.enabled !== 'boolean')
      return undefined;
    for (const key of ['runtime', 'sessionId', 'owner', 'turn'])
      if (typeof row[key] !== 'string' || !row[key].length || row[key].length > 1024)
        return undefined;
    if (row.owner !== identity.conversationKey(row.brand, row.sessionId as string))
      return undefined;
    return row as ExecutionAdmission;
  } catch {
    return undefined;
  }
}

export async function readExecutionChildren(file: string): Promise<ExecutionChild[]> {
  try {
    const children = new Map<string, ExecutionChild>();
    for (const line of (await fs.readFile(`${file}.children`, 'utf8')).split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as Partial<ExecutionChild>;
        if (
          [row.actor, row.parent, row.turn].every(
            (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024
          ) &&
          (row.ended === undefined || (typeof row.ended === 'number' && Number.isFinite(row.ended)))
        ) {
          const key = JSON.stringify([row.actor, row.parent, row.turn]);
          const previous = children.get(key);
          children.set(key, {
            ...(row as ExecutionChild),
            ...(previous?.ended === undefined
              ? {}
              : { ended: Math.max(previous.ended, row.ended ?? 0) })
          });
        }
      } catch {
        /* A torn final ancestry note cannot prove ownership. */
      }
    }
    return [...children.values()];
  } catch {
    return [];
  }
}

export async function appendExecutionChild(file: string, child: ExecutionChild): Promise<void> {
  try {
    await fs.appendFile(`${file}.children`, `${JSON.stringify(child)}\n`, { mode: 0o600 });
  } catch {
    /* Missing proof keeps child coverage incomplete. */
  }
}
