/**
 * Whether each CLI is signed in, as last asked — and when asking again is worth
 * a process.
 *
 * **The answer is stored, and the CLI is asked only when it is missing.** Each
 * ask starts a whole CLI: `claude auth status` peaked at ~141 MB for 0.10 s,
 * Codex's app-server at ~110 MB (measured 2026-10-05, CLI 2.1.289). That check
 * reads local state only, so asking it on a timer can notice nothing that a
 * change on disk would not. Missing means: no record, a record whose stamp is
 * not the port's current one, or a verb that forces it (sign-in, sign-out,
 * *Re-check*, a path setting).
 *
 * One file per brand and binary under `~/.squadron/`, so the answer outlives
 * the IDE and is shared by every window running that binary — and by a fork
 * and stock VS Code on one machine, which share one CLI login and nothing else.
 * A window that finds the record another window wrote, stamp matching, asks
 * nothing. A window whose path setting names another binary keeps its own
 * record (`signInFile`), so neither answer stands in for the other.
 */

import type { AccountSource, CliAdapter } from './adapter';
import type { AccountRowStatus } from './accounts';
import { readJson, writeAtomicJson } from './files';
import type { BrandId } from './model';
import { signInFile } from './paths';

/**
 * Interval, not duration: the shortest gap after a failed ask before the next.
 * A failure is a timeout, a spawn error or output that will not parse; without
 * this a CLI that hangs would be started again on every 3 s pass.
 */
export const RETRY_MS = 60_000;

type SignInRecord = { status: AccountRowStatus; stamp: string };

/** The stored answer of the binary `override` names; none is the default search. */
export async function storedSignIn(
  brand: BrandId,
  opts: { home?: string; override?: string } = {}
): Promise<AccountRowStatus | undefined> {
  return narrow(await readJson<unknown>(signInFile(brand, opts.home, opts.override)))?.status;
}

/**
 * Per window and in memory only: another window may still try. Per brand, not
 * per record file: a window holds one path setting per brand, and changing it
 * forces the next ask past this wait.
 */
const failedAt = new Map<BrandId, number>();

export function signInRetryAt(): number | undefined {
  return failedAt.size ? Math.min(...[...failedAt.values()].map((at) => at + RETRY_MS)) : undefined;
}

/**
 * The pass running for each record file, so a pass for one binary is never
 * joined by a call for another. `refresh()` is not re-entrant and this runs on
 * every pass, so an ask outliving one pass (Codex 0.6 s, a hang 4 s) would
 * otherwise be started again by the next.
 */
const running = new Map<string, Promise<AccountRowStatus | undefined>>();

/**
 * This brand's sign-in, from the store when it can be and from the CLI when it
 * must be.
 *
 * An unforced call joins a pass already running. A forced one waits for it and
 * then asks, because a verb has just changed what the CLI would say and an ask
 * that began before it is an answer to the old question.
 *
 * Answers nothing only when nothing is known: unforced, a failed ask over a
 * stale record answers the record, the best answer on disk. Forced, it answers
 * nothing, so `squadron-models` says unknown rather than reusing a record it
 * was told to recheck.
 */
export function signInFor(
  brand: BrandId,
  source: AccountSource,
  opts: { now: number; force?: boolean; override?: string; home?: string }
): Promise<AccountRowStatus | undefined> {
  const file = signInFile(brand, opts.home, opts.override);
  const before = running.get(file);
  if (before && !opts.force) return before;
  const pass = (async () => {
    if (before) await before;
    return look(brand, source, file, opts);
  })();
  running.set(file, pass);
  const clear = (): void => {
    if (running.get(file) === pass) running.delete(file);
  };
  pass.then(clear, clear);
  return pass;
}

async function look(
  brand: BrandId,
  source: AccountSource,
  file: string,
  opts: { now: number; force?: boolean; override?: string }
): Promise<AccountRowStatus | undefined> {
  // Taken before the ask: an auth file rewritten while the CLI answers then
  // leaves a record under the old stamp, and the next pass asks again.
  const stamp = await source.stamp();
  const record = narrow(await readJson<unknown>(file));
  if (!opts.force) {
    // A stamp that cannot be told is no evidence of a change, and asking on it
    // would write a record every other window then reads as one.
    if (stamp === undefined || record?.stamp === stamp) {
      failedAt.delete(brand);
      return record?.status;
    }
    if (opts.now - (failedAt.get(brand) ?? -Infinity) < RETRY_MS) return record?.status;
  }
  const status = await source.status(opts.override).catch(() => undefined);
  if (!status) {
    failedAt.set(brand, opts.now);
    return opts.force ? undefined : record?.status;
  }
  // An answer that could not be stored is a failure of the store: with no
  // record, the next pass would otherwise ask again, every 3 s.
  const stored =
    stamp !== undefined && (await writeAtomicJson(file, { status, stamp } satisfies SignInRecord));
  if (stored) failedAt.delete(brand);
  else failedAt.set(brand, opts.now);
  return status;
}

/**
 * The stamp and binary each brand's catalog was last refreshed under, in this
 * process. The adapter holds one catalog per brand, so a path setting that
 * names another binary re-reads it as an account switch does.
 */
const caught = new Map<BrandId, string>();
const catalogFailedAt = new Map<BrandId, number>();
const refreshing = new Map<BrandId, Promise<void>>();

/**
 * Refresh an account-sourced model catalog when the account under it may have
 * changed — the stamp it was taken under is not the current one.
 *
 * **Keyed on the stamp, not on the catalog being empty.** The catalog lives in
 * this process and the sign-in record is shared, so a window that reuses the
 * record another window wrote after an account switch never asks the status,
 * and an emptiness test would keep the old account's catalog in it for good.
 * The first pass of a process has no stamp caught, which is the restart case.
 *
 * A failed refresh waits `RETRY_MS`, as a failed ask does. A forced one waits
 * for any refresh already running and then refreshes whatever the stamp says —
 * `squadron-models` re-listed the catalog on every call before this, and still
 * does.
 */
export async function refreshCatalog(
  brand: BrandId,
  cli: Pick<CliAdapter, 'modelSource' | 'refreshModels' | 'account'>,
  opts: { signedIn: boolean; now: number; force?: boolean; override?: string }
): Promise<void> {
  const { account, refreshModels } = cli;
  if (!opts.signedIn || cli.modelSource !== 'account' || !refreshModels || !account) return;
  const before = refreshing.get(brand);
  if (before && !opts.force) return before;
  const pass = (async () => {
    if (before) await before;
    const stamp = await account.stamp();
    if (stamp === undefined) return;
    const key = JSON.stringify([stamp, opts.override?.trim() ?? '']);
    if (!opts.force) {
      if (caught.get(brand) === key) return;
      if (opts.now - (catalogFailedAt.get(brand) ?? -Infinity) < RETRY_MS) return;
    }
    if (await refreshModels(opts.override).catch(() => false)) {
      caught.set(brand, key);
      catalogFailedAt.delete(brand);
    } else {
      catalogFailedAt.set(brand, opts.now);
    }
  })();
  refreshing.set(brand, pass);
  const clear = (): void => {
    if (refreshing.get(brand) === pass) refreshing.delete(brand);
  };
  pass.then(clear, clear);
  return pass;
}

/** Written by a build of this that may not be this one: checked, not trusted. */
function narrow(value: unknown): SignInRecord | undefined {
  const record = value as { status?: unknown; stamp?: unknown } | undefined;
  const status = record?.status as { loggedIn?: unknown; email?: unknown; plan?: unknown };
  if (typeof record?.stamp !== 'string' || typeof status?.loggedIn !== 'boolean') return undefined;
  return {
    status: {
      loggedIn: status.loggedIn,
      ...(typeof status.email === 'string' ? { email: status.email } : {}),
      ...(typeof status.plan === 'string' ? { plan: status.plan } : {})
    },
    stamp: record.stamp
  };
}

export function resetSignInForTest(): void {
  failedAt.clear();
  running.clear();
  caught.clear();
  catalogFailedAt.clear();
  refreshing.clear();
}
