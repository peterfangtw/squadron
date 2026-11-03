import * as args from './args';
import * as claims from '../core/coordination/claims';
import * as git from '../core/git';
import type * as model from '../core/model';
import type * as published from '../core/published';

/**
 * The window holding the session that asked — `pickWindow`'s **first** tier
 * since row 71, so a fan-out lands on the board that asked for it.
 *
 * **Planted first, looked up second, and the order is the whole point.**
 * `SQUADRON_ORIGIN_WINDOW` is written into every child's environment by the
 * window that starts it (`core/session.ts`), which is the one place every
 * brand's child is spawned — so it answers for a Grok or Codex caller as
 * readily as for a Claude one. The record lookup below it answers for a child
 * of a build older than that variable, and for nothing else.
 *
 * That fallback is Claude-only, which is why it could not be the whole answer:
 * it keys on the caller's pid, read out of the CLI's own pid export, and Grok
 * and Codex plant no pid at all (both probed 2026-09-08, so their
 * `IDENTITY_ENV` rows state none). Left as the only tier, origin-first would
 * have held for Claude callers and scattered every other brand's fan-out by
 * cwd.
 *
 * The pid and not the sessionId, where a pid is what there is: it is the only
 * one of the two that is both unique and stable. `claude --resume` against a
 * running conversation puts two live sessions on one sessionId (`renamePlan`
 * refuses outright over it), and `/clear` moves the sessionId in the published
 * record while the one in this process's environment stays as it started.
 * `ownPid` and `readPublished` key on the same pid, so the lookup is that map's.
 *
 * A caller with neither reads as no origin — a hand-typed terminal, or a Claude
 * session `env -u`'d out of its own identity — and `pickWindow` falls through to
 * the cwd tiers as it did before any of this existed.
 */
export function originWindow(
  env: NodeJS.ProcessEnv,
  records: ReadonlyMap<number, published.PublishedLive>
): string | undefined {
  const planted = env.SQUADRON_ORIGIN_WINDOW;
  if (planted !== undefined && planted !== '') {
    return planted;
  }
  const pid = args.ownPid(env);
  return pid === undefined ? undefined : records.get(pid)?.session.windowId;
}

/**
 * Which window to ask, and **the caller's own comes first** (row 71).
 *
 * This text used to say the opposite, with a reason: ranking the origin above
 * the cwd matches "would send a worktree fan-out back into the window it was
 * fanning out of". That is the outcome now wanted. While the panel drew every
 * window's cards, scattering a family across boards cost nothing — each child
 * was visible wherever it landed. A board is its own window's since row 71, so
 * a child that lands elsewhere is one nobody can see beside its parent, and
 * placement *is* the capability. The child appears on the caller's board, under
 * a section named for its cwd, boxed with its parent.
 *
 * The cwd tiers (`windowForCwd`, with its fallback) stay for a caller with no
 * window — a hand-typed terminal, or a child of a build older than the planted
 * variable. Model discovery and spawn both come through here, so they choose
 * the same host from unsorted claims.
 *
 * An origin whose window has gone is simply not in `claims`, which is the live
 * list — so a dead origin falls through to the cwd tiers rather than addressing
 * nobody. A window that died inside the last `CLAIM_STALE_MS` is still listed
 * and can still be picked, deliberately not given a second staleness horizon
 * here, since two readers with a horizon each is how this CLI came to disagree
 * with the panel (`core/coordination/claims.ts`).
 */
export async function pickWindow(
  live: readonly model.WindowClaim[],
  cwd: string,
  origin?: string,
  resolve: (folders: Iterable<string>) => Promise<Map<string, string>> = git.checkoutRoots
): Promise<model.WindowClaim | undefined> {
  const own = origin === undefined ? undefined : live.find((c) => c.id === origin);
  if (own) return own;
  return claims.windowForCwd(live, cwd, resolve, { fallback: true });
}
