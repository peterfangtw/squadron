import { StartupUnknown } from '../startup';
import * as ownerClaim from './owner_claim';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as files from '../files';
import { STARTUPS_DIR } from '../paths';
import { WINDOWS_DIR } from './claims';
import { LINEAGE_DIR } from '../paths';
import { checkFleet } from './spawn';
import { lineageAlive } from './lineage';

type Member = ownerClaim.Known;
type Owner = ownerClaim.Owner;
type Receipt = {
  schema: 1;
  id: string;
  admittedAt: number;
  owner: Owner;
  phase: 'reserved' | 'spawning' | 'spawned' | 'settled';
  child?: Member;
  members?: readonly Member[];
};

export type Reservation = {
  spawning(): Promise<void>;
  bind(pid: number): Promise<void>;
  remember(members: readonly Member[]): Promise<void>;
  release(): Promise<void>;
};

function receipt(raw: unknown): raw is Receipt {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Receipt;
  if (value.child !== undefined && (!value.child || typeof value.child !== 'object')) return false;
  return (
    value.schema === 1 &&
    typeof value.id === 'string' &&
    Number.isFinite(value.admittedAt) &&
    ownerClaim.owner(value.owner) &&
    ['reserved', 'spawning', 'spawned', 'settled'].includes(value.phase) &&
    (value.members === undefined ||
      (Array.isArray(value.members) && value.members.every(ownerClaim.isKnown))) &&
    (value.phase !== 'spawned' || value.child !== undefined) &&
    (value.child === undefined || ownerClaim.isKnown(value.child))
  );
}

async function read(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Strict admission reads intentionally differ from best-effort graph readers. */
export async function reserveStartup(id: string): Promise<Reservation> {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('Invalid startup identity.');
  await fs.mkdir(STARTUPS_DIR, { recursive: true });
  const table = await ownerClaim.native();
  const startedAt = table.starts.get(process.pid);
  if (startedAt === undefined) throw new Error('The admission owner could not be identified.');
  const me: ownerClaim.NewOwner = {
    pid: process.pid,
    startedAt,
    startSource: table.startSource,
    generation: randomUUID()
  };
  const release = await ownerClaim.acquire(
    path.join(STARTUPS_DIR, 'admission.lock'),
    me,
    'Another window is admitting a session. Wait for it to finish and check the original attempt.',
    table
  );
  try {
    await refuseOlderWindows();
    const records = await reconciledReceipts();

    if (records.some((record) => record.id === id))
      throw new StartupUnknown(
        'That startup already has a reservation. Reconcile the original attempt before starting again.'
      );
    const spawns = await fleetSpawns(records);
    const allowed = checkFleet(spawns, Date.now());
    if (!allowed.ok) {
      const limit = allowed.limit;
      throw new Error(
        limit?.kind === 'fleet'
          ? `${limit.count} agent session slots are held by running sessions, starts or unresolved cleanup; the limit is ${limit.max}. Inspect ${STARTUPS_DIR} before releasing uncertain capacity.`
          : limit?.kind === 'burst'
            ? `${limit.count} agent launches were admitted in the last minute; the limit is ${limit.max}. Wait and try again.`
            : allowed.reason
      );
    }
    const initial: Receipt = {
      schema: 1,
      id,
      admittedAt: Date.now(),
      owner: me,
      phase: 'reserved'
    };
    const file = path.join(STARTUPS_DIR, `${id}.json`);
    return await createReservation(file, initial);
  } finally {
    await release();
  }
}

async function refuseOlderWindows(): Promise<void> {
  // Older hosts ignore reservations. They must be reloaded before this host admits work.
  for (const name of await names(WINDOWS_DIR)) {
    if (!name.endsWith('.json')) continue;
    const text = await read(path.join(WINDOWS_DIR, name));
    if (text === undefined) continue;
    const window = JSON.parse(text) as { startupAdmission?: number; updatedAt?: number };
    if (
      window.startupAdmission !== 1 &&
      typeof window.updatedAt === 'number' &&
      Date.now() - window.updatedAt < 90_000
    )
      throw new Error('Reload every older Squadron window before starting another agent session.');
  }
}

async function reconciledReceipts(): Promise<Receipt[]> {
  const records: Receipt[] = [];
  for (const name of await names(STARTUPS_DIR)) {
    if (!name.endsWith('.json')) continue;
    const text = await read(path.join(STARTUPS_DIR, name));
    if (text === undefined) continue;
    const raw: unknown = JSON.parse(text);
    if (!receipt(raw))
      throw new Error(
        `Unsupported startup record: ${path.join(STARTUPS_DIR, name)}. New agent starts are paused.`
      );
    const evidence = raw.phase === 'settled' ? undefined : await ownerClaim.native();
    const ownerGone = evidence && ownerClaim.judge(evidence, raw.owner) === 'gone';
    const boundGone =
      raw.phase === 'spawned' &&
      raw.child &&
      evidence &&
      [raw.child, ...(raw.members ?? [])].every(
        (known) => ownerClaim.judge(evidence, known) === 'gone'
      );
    if (ownerGone && (raw.phase === 'reserved' || boundGone)) {
      const settled: Receipt = { ...raw, phase: 'settled' };
      if (!(await files.writeAtomicJson(path.join(STARTUPS_DIR, name), settled, 'state')))
        throw new Error('An abandoned reservation could not be settled.');
      records.push(settled);
    } else records.push(raw);
  }

  return records;
}

async function fleetSpawns(
  records: readonly Receipt[]
): Promise<{ spawnedAt: number; alive: boolean }[]> {
  const fresh = await ownerClaim.native();
  const spawns = records.map((record) => ({
    spawnedAt: record.admittedAt,
    alive: record.phase !== 'settled'
  }));
  const reserved = new Set(records.map((record) => record.id));
  for (const name of await names(LINEAGE_DIR)) {
    if (!name.endsWith('.json')) continue;
    const text = await read(path.join(LINEAGE_DIR, name));
    if (text === undefined) continue;
    const edge = JSON.parse(text) as { spawnedAt?: unknown; requestId?: string };
    if (typeof edge.spawnedAt !== 'number' || !Number.isFinite(edge.spawnedAt))
      throw new Error('Spawn history could not be read; new agent starts are paused.');
    if (edge.requestId && reserved.has(edge.requestId)) continue;
    const pid = Number(path.basename(name, '.json'));
    const start = fresh.starts.get(pid);
    spawns.push({
      spawnedAt: edge.spawnedAt,
      alive: lineageAlive(pid, { spawnedAt: edge.spawnedAt }, start)
    });
  }
  return spawns;
}

async function createReservation(file: string, initial: Receipt): Promise<Reservation> {
  let record = initial;
  const persist = async (next: Receipt): Promise<void> => {
    if (!(await files.writeAtomicJson(file, next, 'state')))
      throw new Error(`Startup reservation could not be saved: ${file}`);
    record = next;
  };
  await persist(record);
  let chain: Promise<void> = Promise.resolve();
  const update = (change: (current: Receipt) => Receipt): Promise<void> => {
    const next = chain.then(() =>
      record.phase === 'settled'
        ? undefined
        : (() => {
            const next = change(record);
            return next === record ? undefined : persist(next);
          })()
    );
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    spawning: () => update((current) => ({ ...current, phase: 'spawning' })),
    bind: async (pid) => {
      const table = await ownerClaim.native();
      const start = table.starts.get(pid);
      if (start === undefined)
        throw new Error('The started child could not be identified; its reservation is retained.');
      await update((current) => ({
        ...current,
        phase: 'spawned',
        child: { pid, startedAt: start, startSource: table.startSource }
      }));
    },
    remember: (members) =>
      update((current) => {
        const key = (member: Member) =>
          `${ownerClaim.sourceOf(member)}:${member.pid}:${member.startedAt}`;
        const known = new Map((current.members ?? []).map((member) => [key(member), member]));
        for (const member of ownerClaim.onOwnerClock(current.owner, members)) {
          const next: Member = { pid: member.pid, startedAt: member.startedAt };
          if (member.startSource !== undefined) next.startSource = member.startSource;
          known.set(key(next), next);
        }
        return known.size === current.members?.length
          ? current
          : { ...current, members: [...known.values()] };
      }),
    release: () => update((current) => ({ ...current, phase: 'settled' }))
  };
}

/** Active or uncertain capacity is never expired by age. Called by existing pruning. */
export async function pruneStartupRecords(now = Date.now()): Promise<void> {
  for (const name of await names(STARTUPS_DIR)) {
    const file = path.join(STARTUPS_DIR, name);
    if (name.endsWith('.tmp')) {
      try {
        if (now - (await fs.stat(file)).mtimeMs < 24 * 60 * 60_000) continue;
        const text = await read(file);
        if (text === undefined) continue;
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          /* An abandoned partial temporary is not a claim. */
        }
        const candidate = ownerClaim.owner(value)
          ? value
          : receipt(value)
            ? value.owner
            : undefined;
        const evidence = await ownerClaim.native();
        // Live, or on a clock this table cannot judge: its writer may still finish.
        if (candidate && ownerClaim.judge(evidence, candidate) !== 'gone') continue;
        const writer = /\.json\.(\d+)\.\d+\.tmp$/.exec(name)?.[1];
        if (writer && evidence.starts.has(Number(writer))) continue;
        if ((await read(file)) === text) await fs.rm(file, { force: true });
      } catch {
        /* Unavailable evidence leaves the temporary for a later sweep. */
      }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    try {
      const text = await read(file);
      const raw: unknown = text === undefined ? undefined : JSON.parse(text);
      if (receipt(raw) && raw.phase === 'settled' && now - raw.admittedAt > 7 * 24 * 60 * 60_000)
        await fs.rm(file);
    } catch {
      /* Unknown capacity stays reserved. */
    }
  }
}
