import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as files from '../files';
import * as paths from '../paths';
import * as claims from './owner_claim';
import * as scan from '../scan';
import * as control from '../control';
import type { BrandId } from '../model';
import type { TreeMember } from '../control';
import {
  LIVE_ACTIVE_MS,
  LIVE_FAILURE_MS,
  LIVE_TIMEOUT_MS,
  USAGE_REFRESH_MS,
  liveDue,
  type LiveHint
} from '../usage_policy';
import { isStartSource, type StartSource } from '../platform/processes';

/** A retained member, on the clock its owner's capability read it (`claims.onOwnerClock`). */
export type AttemptMember = TreeMember & { startSource?: StartSource };
export type Attempt = {
  id: string;
  owner: claims.Owner;
  members?: readonly AttemptMember[];
  generation: string;
  checkAfter?: number;
};
/** Version 1 still: the live fields are optional, and an older host reads
 *  named fields and writes back what it read. */
export type UsageState = {
  version: 1;
  generation: string;
  notBefore: number;
  /** No activity-driven read before this. Cleared with the account. */
  activeAfter?: number;
  /** The fallback's read, which may own a temporary child. */
  attempt?: Attempt;
  /**
   * An activity-driven read over an existing pipe or request: no child. A slot
   * of its own because an older host recovers `attempt` with the hourly
   * cooldown; it neither sees nor recovers this one.
   */
  live?: Attempt;
};
let identity: Promise<claims.Identity> | undefined;
const reaps = new control.Reaps();
const completed = new Map<string, () => Promise<unknown>>();

/**
 * This process's identity, from the first complete table on a recognized
 * clock. Without one it is start 0, which no reader judges: such a lock or
 * attempt is never recovered by another window, only released by this one.
 * Only an identity is kept, so a later scan can still find one.
 */
async function owner(): Promise<claims.NewOwner> {
  const found =
    identity ??
    scan.scanProcesses(true).then((table): claims.Identity => {
      const startedAt = table.starts.get(process.pid);
      return table.complete && isStartSource(table.startSource) && startedAt !== undefined
        ? { pid: process.pid, startedAt, startSource: table.startSource }
        : { pid: process.pid, startedAt: 0 };
    });
  const me = await found;
  if (me.startedAt !== 0) identity = found;
  return { ...me, generation: randomUUID() };
}

export async function readState(brand: BrandId, home?: string): Promise<UsageState | undefined> {
  let text: string;
  try {
    text = await fs.readFile(paths.usageStateFile(brand, home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value = JSON.parse(text) as Partial<UsageState>;
  if (
    value.version !== 1 ||
    typeof value.generation !== 'string' ||
    !Number.isFinite(value.notBefore) ||
    (value.activeAfter !== undefined && !Number.isFinite(value.activeAfter))
  )
    throw new Error('Unreadable usage refresh state; refusing an unpaced read.');
  if (
    value.attempt &&
    (!claims.owner(value.attempt.owner) ||
      typeof value.attempt.id !== 'string' ||
      typeof value.attempt.generation !== 'string' ||
      (value.attempt.checkAfter !== undefined && !Number.isFinite(value.attempt.checkAfter)) ||
      (value.attempt.members !== undefined &&
        (!Array.isArray(value.attempt.members) ||
          !value.attempt.members.every((member) => claims.isKnown(member)))))
  )
    throw new Error('Unreadable usage attempt ownership.');
  if (
    value.live &&
    (!claims.owner(value.live.owner) ||
      typeof value.live.id !== 'string' ||
      typeof value.live.generation !== 'string')
  )
    throw new Error('Unreadable live usage ownership.');
  return value as UsageState;
}

/** Short transactions never span a provider request or native cleanup. */
export async function mutate<T>(
  brand: BrandId,
  home: string | undefined,
  change: (state: UsageState) => Promise<T> | T
): Promise<T> {
  const file = paths.usageStateFile(brand, home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const release = await claims.acquire(`${file}.lock`, await owner(), 'Usage state is busy.');
  try {
    const state = (await readState(brand, home)) ?? {
      version: 1,
      generation: randomUUID(),
      notBefore: 0
    };
    const before = JSON.stringify(state);
    const answer = await change(state);
    if (before !== JSON.stringify(state) || !(await readState(brand, home))) {
      if (!(await files.writeAtomicJson(file, state)))
        throw new Error('Could not persist usage cooldown.');
    }
    return answer;
  } finally {
    await release();
  }
}

export async function generation(brand: BrandId, home?: string): Promise<string> {
  return (
    (await readState(brand, home))?.generation ?? mutate(brand, home, (state) => state.generation)
  );
}

export async function admit(
  brand: BrandId,
  home: string | undefined,
  now: number,
  interval = USAGE_REFRESH_MS,
  expectedGeneration?: string
): Promise<Attempt | undefined> {
  const me = await owner();
  const answer = await mutate(brand, home, async (state) => {
    if (expectedGeneration !== undefined && state.generation !== expectedGeneration)
      return undefined;
    if (Math.max(state.notBefore, state.attempt?.checkAfter ?? 0) > now) return undefined;
    if (state.attempt) {
      state.attempt.checkAfter = now + interval;
      const table = await scan.scanProcesses(true);
      // Start 0 is an owner that never had an identity; `unknown` is a partial
      // table or another clock. Neither proves the owner gone.
      if (
        state.attempt.owner.startedAt === 0 ||
        claims.judge(table, state.attempt.owner) !== 'gone'
      )
        return undefined;
      if (state.attempt.members === undefined)
        return new Error('Interrupted usage spawn has no native identity; retaining ownership.');
      const members = state.attempt.members;
      if (
        members.some((member) => member.startedAt === 0 && table.parents.has(member.pid)) ||
        members.some((member) => claims.judge(table, member) === 'unknown')
      )
        return undefined;
      const live = members.filter((member) => claims.judge(table, member) === 'live');
      if (live.length) {
        await control.endBySignal(live, reaps);
        return undefined;
      }
      const sameAccount = state.attempt.generation === state.generation;
      delete state.attempt;
      if (sameAccount) state.notBefore = Math.max(state.notBefore, now + interval);
      return undefined;
    }
    // A live read is seconds long; the fallback waits out its timeout, no more.
    if (state.live && !(await releaseDead(state, now))) {
      state.notBefore = Math.max(state.notBefore, now + LIVE_TIMEOUT_MS);
      return undefined;
    }
    const attempt: Attempt = { id: randomUUID(), owner: me, generation: state.generation };
    state.attempt = attempt;
    state.notBefore = now + interval;
    return attempt;
  });
  if (answer instanceof Error) throw answer;
  return answer;
}

/**
 * Clear a dead host's live read, backing off live reads alone; whether the
 * slot is free now. A live read owns no child, so its owner's exit is all.
 */
async function releaseDead(state: UsageState, now: number): Promise<boolean> {
  const live = state.live;
  if (!live) return true;
  const table = await scan.scanProcesses(true);
  if (live.owner.startedAt === 0 || claims.judge(table, live.owner) !== 'gone') return false;
  delete state.live;
  if (live.generation === state.generation)
    state.activeAfter = Math.max(state.activeAfter ?? 0, now + LIVE_FAILURE_MS);
  return true;
}

/**
 * Admit one activity-driven read machine-wide, or say when to ask again.
 *
 * The whole deadline is recomputed under the claim. `observedAt` reads the
 * store's newest observation and runs inside it, because coordination does
 * not import the store and a value read before the claim could be stale.
 * `after` absent means nothing is due until something changes. The returned
 * `observedAt` and `activeAfter` are the ones read under the claim.
 */
export async function admitLive(
  brand: BrandId,
  home: string | undefined,
  now: number,
  opts: { generation: string; hint: LiveHint; observedAt(): Promise<number | undefined> }
): Promise<
  | { attempt: Attempt; observedAt: number | undefined }
  | { after?: number; observedAt: number | undefined; activeAfter: number | undefined }
> {
  const me = await owner();
  return mutate(
    brand,
    home,
    async (
      state
    ): Promise<
      | { attempt: Attempt; observedAt: number | undefined }
      | { after?: number; observedAt: number | undefined; activeAfter: number | undefined }
    > => {
      const seen = await opts.observedAt();
      const waiting = (after?: number) =>
        after === undefined
          ? { observedAt: seen, activeAfter: state.activeAfter }
          : { after, observedAt: seen, activeAfter: state.activeAfter };
      if (state.generation !== opts.generation) return waiting();
      if ((state.activeAfter ?? 0) > now + LIVE_FAILURE_MS)
        state.activeAfter = now + LIVE_FAILURE_MS;
      if (state.attempt) return waiting(now + LIVE_ACTIVE_MS);
      if (state.live) {
        await releaseDead(state, now);
        return waiting(now + LIVE_ACTIVE_MS);
      }
      const due = liveDue({
        ...opts.hint,
        observedAt: seen,
        activeAfter: state.activeAfter
      });
      if (due === undefined || due > now) return waiting(due);
      const attempt: Attempt = { id: randomUUID(), owner: me, generation: state.generation };
      state.live = attempt;
      state.activeAfter = now + LIVE_ACTIVE_MS;
      return { attempt, observedAt: seen };
    }
  );
}

/**
 * Release a live attempt. Fenced by account generation: a read that outlived
 * its account backs off nothing for the next one. A release that cannot be
 * written is kept and retried by `settle`, as `complete` is, or its own live
 * host would hold the slot until it exits. Returns the `activeAfter` it wrote,
 * or `undefined` when the attempt did not apply.
 */
export async function completeLive(
  brand: BrandId,
  home: string | undefined,
  attempt: Attempt,
  now: number,
  observed: boolean
): Promise<number | undefined> {
  const key = `${paths.usageStateFile(brand, home)}#live`;
  const save = async (): Promise<number | undefined> => {
    const written = await mutate(brand, home, (state): number | undefined => {
      if (state.live?.id !== attempt.id) return;
      delete state.live;
      if (state.generation !== attempt.generation) return;
      state.activeAfter = Math.max(
        state.activeAfter ?? 0,
        now + (observed ? LIVE_ACTIVE_MS : LIVE_FAILURE_MS)
      );
      return state.activeAfter;
    });
    completed.delete(key);
    return written;
  };
  completed.set(key, save);
  return save();
}

export async function remember(
  brand: BrandId,
  home: string | undefined,
  attempt: Attempt,
  members: readonly AttemptMember[]
): Promise<void> {
  await mutate(brand, home, (state) => {
    if (state.attempt?.id !== attempt.id) throw new Error('Usage attempt lost ownership.');
    state.attempt.members = claims.onOwnerClock(state.attempt.owner, members);
  });
}

export async function starting(
  brand: BrandId,
  home: string | undefined,
  attempt: Attempt
): Promise<void> {
  await mutate(brand, home, (state) => {
    if (state.attempt?.id !== attempt.id) throw new Error('Usage attempt lost ownership.');
    delete state.attempt.members;
  });
}

export async function settle(brand: BrandId, home?: string): Promise<void> {
  const file = paths.usageStateFile(brand, home);
  await completed.get(file)?.();
  await completed.get(`${file}#live`)?.();
}

/** The `notBefore` it wrote, or `undefined` when the attempt or generation did not match. */
export async function complete(
  brand: BrandId,
  home: string | undefined,
  attempt: Attempt,
  now: number,
  interval: number
): Promise<number | undefined> {
  const file = paths.usageStateFile(brand, home);
  const save = async (): Promise<number | undefined> => {
    const written = await mutate(brand, home, (state): number | undefined => {
      if (state.attempt?.id !== attempt.id) return;
      delete state.attempt;
      if (state.generation !== attempt.generation) return;
      state.notBefore = Math.max(state.notBefore, now + interval);
      return state.notBefore;
    });
    completed.delete(file);
    return written;
  };
  completed.set(file, save);
  return save();
}
