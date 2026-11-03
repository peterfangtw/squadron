/**
 * The environment vocabulary a CLI plants for its shell tools.
 *
 * One boundary and nothing else: every brand's spelling of "the session id of
 * whoever is calling". It sits below the adapters on purpose — the set has to
 * be readable *as a set*, and no single adapter can name its siblings.
 * `AGENTS.md`'s brand-seam bullet names this file for that reason.
 *
 * What each CLI plants, and when it was observed:
 *
 * | Brand | Variables | Observed |
 * | --- | --- | --- |
 * | Claude | `CLAUDE_CODE_SESSION_ID`, and `CLAUDE_PID` | 2.1.220 / 2.1.237, confirmed live again on 2.1.258, 2026-09-08 |
 * | Grok | `GROK_SESSION_ID`, plus the marker `GROK_AGENT=1`. **No pid** | 1.0.4, 2026-08-16; pid probed and absent on 1.0.13, 2026-09-08 |
 * | Codex | `CODEX_SESSION_ID` — the durable `thread/start` id, echoed as `CODEX_THREAD_ID`. **No pid** | 0.151.0, 2026-09-02; pid probed and absent on 0.153.2, 2026-09-08 |
 *
 * **These exist only in the environment a CLI gives a *shell tool*, not in the
 * CLI process's own.** Measured 2026-09-02 against a spawned Codex session:
 * `ps eww` on the CLI shows only `SQUADRON_LINEAGE_ORIGIN`. So a verb reads
 * one because it runs inside a tool call; nothing reads one off a card.
 *
 * **The invariant:** the *ids* here are read by `cli/args.ts`'s `ownSessionId`
 * and deleted by `core/session.ts`'s `childTransport` — the set that is *scrubbed*
 * must equal the set that is *read*, or a child answers to an ancestor's
 * thread. Both consumers enumerate the table rather than quoting it, so a
 * fourth brand is one row. (The scrub is the *default*: `options.env` is
 * applied after it and may plant one deliberately.)
 */

import type { BrandId } from './model';
import type { ShellFamily } from './platform/commands';

/** A brand's identity spelling: the id it plants, and the marker that proves
 *  the process really is that brand's, where the CLI publishes one. */
export type IdentityEnv = {
  readonly id: string;
  /** Set only in a process that genuinely is this brand's tool child, so it
   *  survives an ancestor's leaked id. Only Grok publishes one. */
  readonly marker?: string;
  /**
   * The pid this CLI publishes its own session's state under, where it
   * publishes one — `cli/args.ts`'s `ownPid`, which is `pickWindow`'s origin
   * tie-break.
   *
   * **Absent is a measurement, not a gap.** Grok 1.0.13 and Codex 0.153.2 were
   * both probed on 2026-09-08 and plant no pid under any spelling; the runs and
   * the method are `cli_state/grok/processes.md` and
   * `cli_state/codex/sessions.md`. A caller of either reads as unknown, which
   * every caller already handles, and a release that starts planting one is a
   * column here rather than an edit to `ownPid`.
   *
   * Separate from `id` because the two are not the same fact: Claude's pid
   * tracks a `--resume` that changes the process, which the session id does
   * not.
   */
  readonly pid?: string;
};

/**
 * **Declaration order is the measured fallback order** — do not reorder for
 * tidiness, it is `ownSessionId`'s answer and `ownPid`'s. Claude's id is the
 * one that leaks down a process tree — an extension host launched from a Claude
 * session hands it to everything under it (observed 2026-08-16) — so Codex sits
 * above it. Bare `GROK_SESSION_ID` is last: a process with the id and not the
 * marker is the weakest witness of all.
 *
 * **That ordering protects the ids and not the pid**, because only Claude
 * states a pid at all: there is no row above it for a leaked `CLAUDE_PID` to
 * lose to, and `ownPid` says so at its own line.
 */
export const IDENTITY_ENV: Readonly<Record<BrandId, IdentityEnv>> = {
  codex: { id: 'CODEX_SESSION_ID' },
  claude: { id: 'CLAUDE_CODE_SESSION_ID', pid: 'CLAUDE_PID' },
  grok: { id: 'GROK_SESSION_ID', marker: 'GROK_AGENT' }
};

/**
 * Every name in the table, id and marker alike: what `childTransport` deletes
 * and what the scrub test plants, echoes and asserts on. One list, so the two
 * cannot differ by a marker one of them forgot.
 *
 * **`pid` is deliberately not in it.** The scrub exists so a child cannot
 * answer to an ancestor's *thread*, and a stale pid cannot do that — it is read
 * only by `ownPid`, only to break a tie between two equally good windows, and
 * the ancestor's window is the one a child of it usually wants anyway. Deleting
 * it would also take `CLAUDE_PID` out of a Claude child that has a real use for
 * it, to fix nothing. Add it here only with a measured case where the leak
 * picks the wrong window.
 */
export const IDENTITY_NAMES: readonly string[] = Object.values(IDENTITY_ENV).flatMap(
  ({ id, marker }) => (marker === undefined ? [id] : [id, marker])
);

/**
 * The shell each CLI's command tool runs what it is handed — the receiver of
 * every verb command we write for a session. Windows, observed 2026-10-25 by
 * tool-call ancestry: Claude 2.1.296's Bash tool under Git Bash; Codex
 * 0.163.0 and Grok 1.0.62 under `WindowsPowerShell\v1.0\powershell.exe`.
 * Unobserved: Claude's opt-in PowerShell tool (`CLAUDE_CODE_USE_POWERSHELL_TOOL`,
 * also its fallback without Git Bash), which still receives POSIX text.
 */
export const TOOL_SHELL: Readonly<Record<BrandId, ShellFamily>> = {
  codex: 'native',
  claude: 'posix',
  grok: 'native'
};

export const EXECUTION_CONTEXT_ENV = 'SQUADRON_EXECUTION_CONTEXT';

/** Live / press identity: two brands may share a session id. */
export function conversationKey(brand: BrandId, sessionId: string): string {
  return `${brand}\0${sessionId}`;
}
