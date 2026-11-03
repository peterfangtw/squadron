import { DEFAULT_WARM_POLICY } from '../warm_policy';

/**
 * Every bound on whether an agent may act on a session, in one file, so the
 * thresholds that must agree are read side by side. The send bounds come
 * first, the spawn caps at the foot.
 */

/**
 * Two kinds of send bound, and they are not interchangeable. **Cost** is the
 * stale and context guards: a wake past the target's cache deadline re-sends
 * its whole context, and a turn over `CONTEXT_MAX` compacts instead of
 * answering. Somebody else pays that, so `--force` — the sender saying it knows
 * — lifts these two and nothing else. **Bursts** are the counter, in messages
 * rather than tokens: `SEND_BURST` ends a runaway exchange whatever it costs,
 * and nothing lifts it. Changing the counter is no reason to touch the cost
 * guards.
 *
 * Constants, not settings: the shim checks too, and a plain node process
 * cannot read the host's configuration, so a raised setting would be refused
 * by the shim before the window's figure was consulted.
 */

/** How far ahead of `cacheUntil` a target already counts as stale. */
export function staleMargin(ttlMs: number): number {
  return ttlMs / 12;
}

/** How long a target that states no cache lifetime at all may idle before a
 *  wake is refused as stale: Claude's, the longest default. */
export const TARGET_STALE_MS = staleBound(DEFAULT_WARM_POLICY.ttlMs.claude);

/** The idle past which a target with this lifetime but no stamp is stale. */
export function staleBound(ttlMs: number): number {
  return ttlMs - staleMargin(ttlMs);
}

/**
 * The share of a target's context past which a message is refused. Above this a
 * turn is likely to compact rather than to answer, and the compaction is paid
 * for by the message that arrived.
 */
export const CONTEXT_MAX = 80;

/**
 * A wait expires a minute inside the stale bound: its resolution is a send that
 * obeys the stale guard, so a wait outliving that bound would be refused the one
 * message it exists to send. The caller's cache lifetime may shorten it.
 */
export const WAIT_TTL_MS = TARGET_STALE_MS - 60_000;

/**
 * How much text one message may carry. Far above a hand-off brief and far below
 * anything that would compact a target on arrival. Not `checkPrompt`'s cap:
 * that one is about what fits on a command line, and this is a JSON frame.
 */
export const MAX_TEXT = 16_000;

/** Accepted messages per rolling minute in the receiving IDE window, shared by
 *  sends, answers and wait resolutions. */
export const SEND_BURST = 10;
export const SEND_BURST_MS = 60_000;

/**
 * How many reports one member may have parked against a single wait before the
 * hold gives up on it.
 *
 * **Reaching it releases; it never truncates and never drops.** The member's
 * parked reports go out in the order they were accepted, followed by the one
 * that hit the cap. Only *that* member's — a sibling's earlier report stays
 * held for the convergence, so the order this preserves is per-member, which is
 * the order a correction actually needs.
 *
 * **The allowance then starts again**, because releasing empties what the cap
 * counts. Nine reports from one member are four held, a release of five, three
 * held, a release of four — not four held and five sent. That is a bound on how
 * much of one member the convergence can carry, not a budget it spends once,
 * and the order is preserved either way. Dropping is refused by the measurement this whole feature
 * rests on — the "redundant" report in the 2026-08-26 run carried a correction
 * — and *falling through* was tried and is worse than either: it lets the
 * report that hits the cap overtake the four it corrects, which is an inversion
 * neither truncation nor today's behaviour can produce.
 *
 * Bytes are bounded separately and elsewhere: `MAX_TEXT` is what a convergence
 * is actually refused on, and a count cannot bound it — one legal report may be
 * `MAX_TEXT` long on its own. `core/coordination/wait.ts` fits what it can and hands back
 * the rest.
 */
export const REPORTS_PER_MEMBER = 4;

/**
 * Spawn admission runs in the host. `checkFleet` is called from the spawn
 * precheck (`host/request_host.ts`, through `checkVerbSpawn`) and from startup
 * admission (`startup_records.ts`). No shim consults these, and nothing here
 * bounds cost or a loop. What they bound is what the machine can hold.
 *
 * The two shapes of "too many". A burst is the dangerous one: `claimRequests`
 * runs an unbounded `Promise.all` over every pending file, so requests dropped
 * together become that many `createTerminal` calls and that many CLI processes
 * inside one 500ms tick. The standing fleet is the slow one — a loop spawning a
 * peer every minute never bursts and still ends the hour with sixty sessions
 * resident, each holding a pty, a node process and its context.
 *
 * Numbers over reasons: five at once is what Phase 0 measured a window absorbing
 * without stumbling. Fifteen resident is the standing ceiling, and what bounds it
 * is not the CPU — an idle session is a pty and a sleeping node process — but the
 * panel's own 3s pass, which re-reads every session's files on every tick. Both
 * are deliberately low — an agent told "too many at once" can wait and ask again,
 * which is the behaviour we want out of a runaway loop.
 *
 * Only spawned sessions are counted, because only they are ours to refuse: a
 * session someone started by typing `claude` never asked us for anything and
 * cannot be told no.
 */
export const BURST_WINDOW_MS = 60_000;
export const BURST_MAX = 5;
export const FLEET_MAX = 15;
