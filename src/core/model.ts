import type { BrandId } from './brands';
import type { ControlReading } from './session_target';
export type { BrandId } from './brands';

import type { TurnOutcome } from './events';

/**
 * A ping written only to keep the prompt cache warm, latched until real work.
 *
 * `written` by the drain, `open` once the CLI's turn starts, `closed` when the
 * brand admits that turn ended. A closed latch outlives the idle edge: Claude
 * states `idle` after its `result`, and every reader at or after the edge has
 * to see the same fact. Cleared by the next non-warm drain and by a turn the
 * CLI starts itself.
 */
export type WarmTurn = {
  /** The admitted input, stable across completion and late usage. */
  id?: string;
  /** Confirmed model traffic; a reserved or written input supplies none. */
  trafficAt?: number;
  phase: 'written' | 'open' | 'closed';
  /** It errored, was interrupted, asked, or reached for a tool. */
  failed?: true;
  /** The context held when the ping was written: the prefix it should reuse. */
  prefix?: number;
  /** Cached input tokens the ping's first request read. Absent is unknown. */
  cached?: number;
};

/**
 * What Claude is doing. The CLI's own vocabulary minus `shell`, which is not a
 * fourth state but `idle` with a command still running — see `hasCommand`.
 */
export type SessionStatus = 'busy' | 'idle' | 'waiting' | 'unknown';

/** A turn is open: working, or blocked on a dialog it has not had answered. */
export function isMidTurn(status: SessionStatus): boolean {
  return status === 'busy' || status === 'waiting';
}

const START_MATCH_MS = 5000;

/**
 * Both stamps date the same fork, one from `ps` `lstart` and one from
 * `Date.now()` after `spawn()` returned, so the gap is only the second
 * `lstart` truncates: 71–994 ms over the ten sessions live on 2026-09-16.
 * Five seconds leaves room while still rejecting pid reuse, whose starts differ
 * by much longer.
 *
 * Nothing here may be read on a CLI's own clock. Claude stamps its session file
 * when it finishes booting, which ran 6781 ms after the fork on a loaded
 * machine — outside this window for the life of the session, and every reader
 * of that session's published record silently lost it
 * (`core/claude/discover.ts`).
 */
export const sameSessionStart = (a: number | undefined, b: number | undefined): boolean =>
  a !== undefined && b !== undefined && Math.abs(a - b) < START_MATCH_MS;

/**
 * How much of one rate-limit window the account has spent. `resetsAt` is epoch
 * seconds, and absent when a source reported the percentage without one.
 */
export type Reading = { pct: number; resetsAt?: number };

/**
 * One window of an account's plan usage, carrying its own names.
 *
 * `id` is the long one the tip prints and the stable key a stored record is
 * matched on; `short` is what the chip prints. Both are data because a brand
 * states which windows it has — Claude two, Grok one, and a brand that later
 * reports a three-day window is a new `id` at the seam rather than a new case
 * in the renderer.
 *
 * `pct` has three states, because the chip draws three things. A number is the
 * figure. Absent is a window this brand has and we have no reading for yet, and
 * draws a dash. `null` is a window this brand does not have at all, and draws
 * `none` — Grok has no 5-hour limit, and saying so is not the same as having no
 * figure for one. The distinction is stated in the record rather than derived,
 * so the renderer still knows nothing about brands.
 */
export type RateWindow = {
  id: string;
  short: string;
  pct?: number | null;
  resetsAt?: number;
  /**
   * When this window was last stated, epoch milliseconds.
   *
   * **On the window and not on the reading**, because a window is the thing a
   * source observes: one `get_usage` answer can carry a figure for one window
   * and nothing for the other, and the store keeps whichever statement of each
   * is newest (`usage.mergeReadings`). A stamp per reading could not express
   * that — a window carried out of an older reading took the newer one's stamp
   * with it, and so outranked the genuine update that arrived next.
   *
   * Dated whether or not it carries a figure: a window with none still says the
   * brand has one and may name the period, and both are weighed by age. Absent
   * only on a record written before this field existed, which ranks oldest.
   */
  at?: number;
};

/**
 * One reading of the account, in the panel's words.
 *
 * `at` is when the reading was taken, epoch milliseconds, and every source
 * stamps one: it is the only thing two readings of a window are ranked by
 * (`core/usage.ts`), because a figure can fall inside a window and so says
 * nothing about which of two readings is later. Absent means an age nothing
 * could establish — a record written before this was true — which ranks last
 * and is not drawn as an age.
 *
 * On a merged reading it is the newest of `windows`' own stamps, which is what
 * the accounts row means by "updated 2m ago" — the last time the account was
 * heard from at all, not the age of every figure in the row.
 */
export type RateLimits = {
  at?: number;
  windows: RateWindow[];
};

/**
 * What a start will run on, decided at one moment and carried to the adapter
 * as one value.
 *
 * **Launch only.** This describes a child before it exists; it never becomes
 * the state of a running session. A live session has a brand-selected handle
 * already; its next-message target travels through `SessionHandle.messages.send`.
 * Its effort is read back off the transcript — a reading that moves the moment
 * somebody types `/effort` and that nothing here may overwrite.
 *
 * Every field is optional, because a machine offering no model at all still
 * makes a start, naming none. What each absence means is not the same:
 *
 * - **no `brand`** is the historical fallback — inherit the spawning session's,
 *   else Claude. It is *not* the same as a brand string nothing recognises,
 *   which reaches `adapter()`, finds no row, and refuses the start. Absence and
 *   unknown must stay distinct wherever one of these is assembled, or an old
 *   cross-window request file starts the wrong CLI.
 * - **no `model`** is the account's own default, which is also what `''` means:
 *   `startOwned` folds the two together.
 * - **no `window`** is "say nothing on the launch line" — the account decides,
 *   and the card reads the window off the wire.
 * - **no `effort`** is "send no override". It is not a value: no adapter is
 *   handed `default` or `auto` unless that is a native spelling it takes.
 *
 * `effort` is opaque and **native to the brand** — Claude's `--effort`, Grok's
 * `--reasoning-effort`, Codex's thread-open config. There is no common scale
 * and nothing here maps between them; each adapter owns its own vocabulary at
 * its own seam.
 *
 * Written whole rather than field by field, which is the whole reason it is one
 * type: a window is a property of a model, and an effort is a property of a
 * model too, so writing one without the others is how a stale half pins a
 * selection the reader has moved off.
 */
export type LaunchTarget = {
  brand?: BrandId;
  model?: string;
  window?: number;
  effort?: string;
};

/** Running sessions keep their handle's brand; messages carry the remaining whole pick. */
export type SendTarget = Omit<LaunchTarget, 'brand'>;

/**
 * Inline bytes, with no file on disk. This is the pasted image shared by the
 * webview and cross-window requests, so its type belongs outside CLI frames.
 * Capabilities keep images away from brands that cannot take them.
 */
export type ImageBlock = { mediaType: string; data: string };

/**
 * One `permission_suggestions` entry: read for its wording, echoed whole.
 *
 * Here rather than in Claude's frame file, because the dock paints it and
 * the allow path echoes `raw` back — the panel's shape, not a wire enum.
 */
export type PermissionSuggestion = {
  /** `addRules` · `setMode` · `addDirectories` … */
  kind: string;
  /** Where an always-allow persists this, in words safe to show — named by
   *  the brand that read it, which alone knows its scopes. Absent when that
   *  brand cannot say, and then the request offers no always-allow. */
  where?: string;
  /** The suggestion exactly as it arrived, to hand back on an allow. Its rule
   *  syntax is the CLI's, and the CLI's own suggestion is a known-correct rule
   *  for this one call — which is why it is echoed rather than recomposed. */
  raw: Record<string, unknown>;
};

/** `PermissionSuggestion.where` for a grant that lasts as long as the session. */
export const SESSION_ONLY = 'this session only';

/** Our cross-window decision shape; each brand owns its serialization. */
export type Decision =
  | {
      allow: true;
      /** An ask's picks, `picks[i]` indexing `questions[i].options`. Absent for
       *  a permission prompt, which has nothing to choose. */
      picks?: number[][];
      /** What was typed per question, indexed like `picks`. What it means is
       *  `answerPayload`'s to say (`core/answers.ts`), which is where it is
       *  read; the webview declares the same field on `RequestDecision`, and
       *  `core/coordination/requests.ts` carries this whole shape cross-window. */
      texts?: string[];
      /** What was said *about* a pick, indexed like `picks`. Rides as
       *  `annotations` rather than as an answer — `annotationPayload`
       *  (`core/answers.ts`) is where the rule for it lives, and why it is not
       *  the same field as `texts`. */
      notes?: string[];
      /** Allow this again without asking, by handing back the CLI's own
       *  suggestion. Ignored when the request carried none. */
      always?: boolean;
    }
  /** A refusal, and the words the model is told instead of the tool's result:
   *  the ask's "Reply instead", and the permission dialog's reason box. Absent
   *  still denies — `body()` writes a neutral line of its own. */
  | { allow: false; message?: string };

/**
 * How a window is reached on the model that has it.
 *
 * Three values because the CLI has three behaviours, not because three read
 * tidily (probed 2026-08-27/28 on 2.1.241 —
 * `docs/reference/cli_state/claude/protocol.md`):
 *
 * - `plain` — `--model <id>` and nothing else. The model has one window, or
 *   this is the one it takes by default.
 * - `suffix` — the id carries `[1m]`. The CLI has no `[200k]` counterpart:
 *   `claude-opus-5[200k]` answers *"there's an issue with the selected
 *   model"*, so this spelling only ever reaches *wider*.
 * - `flag` — `CLAUDE_CODE_DISABLE_1M_CONTEXT`, which holds a model with a
 *   native 1M window down to 200k. It outranks the suffix and does not refuse,
 *   so it is the only *deterministic* window there is.
 *
 * **The asymmetry is the whole point.** 200k can be pinned; 1M can only be
 * asked for, because entitlement is the account's answer and it arrives as a
 * 400 in that session's own thread — or, worse, as a silent 200k. So a start
 * states what it asked for and the card says what it got.
 *
 * The words here are ours. What `suffix` and `flag` *spell* is
 * `core/claude/adapter.ts`'s, and nothing else in `src/` may compose either.
 */
export type WindowReach = 'plain' | 'suffix' | 'flag';

export type Session = {
  /** Optional for old records; invalid metadata remains explicit and cannot restore legacy control. */
  control?: ControlReading;
  pid: number;
  sessionId: string;
  /** Where the conversation began, which is what groups the card. */
  cwd: string;
  /**
   * Where the session is standing *now*, when that is not where it began.
   *
   * The branch chip is read from here and the group is not: a session that
   * enters a worktree is working on that worktree's branch, but the work still
   * belongs to the repository it was cut from. `core/claude/discover.ts` makes
   * the same split for a discovered twin, off the transcript; this is the same
   * fact arriving on the wire instead.
   */
  liveCwd?: string;
  /**
   * The live branch's worktree flag. Keep worktree paired with repoRoot for the
   * origin's grouping; overwriting one with live data describes two directories
   * and can move the card out of its repo's group.
   * liveCwd, branch, detached and this flag describe where the session stands.
   * State false when the live reading answers. Absent uses the origin's flag:
   * the session never moved, or Git cannot describe its new directory.
   */
  liveWorktree?: boolean;
  /**
   * Whose CLI this is. The adapter that found or started the session states
   * it; never `ui/` or `webview/` (root `AGENTS.md`). Optional: a source that
   * cannot say draws no mark rather than the wrong one.
   */
  brand?: BrandId;
  /**
   * Whether a prompt may carry inline images. Stated by the adapter that
   * started or found the session. Absent means yes — Claude's default, and
   * the reading of any record written before this field existed.
   */
  images?: boolean;
  /** Session name: the CLI's own, which may be derived from cwd or AI-titled. */
  name: string;
  /** Where that name came from. `derived` means cwd + suffix, not a title. */
  nameSource?: string;
  status: SessionStatus;
  /**
   * A command of the session's own is running — a tool call, or something the
   * user backgrounded. Independent of `status`: the CLI reports it only while
   * a session is otherwise idle, and the process table sees it in every state.
   */
  hasCommand: boolean;
  /** Present when status is `waiting`: "input needed", "permission prompt". */
  waitingFor?: string;
  /** How this session's last turn ended, when its CLI said so on the pipe —
   *  `LiveState.lastOutcome`. Owned sessions only; absent until a turn has
   *  ended with a stated outcome, and again once the next one begins. */
  turnOutcome?: TurnOutcome;
  /** How many turns this session has finished — `LiveState.turnsEnded`, so a
   *  reader comparing two observations sees a finish that coalescing hid.
   *  Owned sessions only; absent on every discovered twin, and on the record
   *  of a window older than the field. */
  turnsEnded?: number;
  /** How the turn `turnsEnded` last counted ended, when a close said so —
   *  `LiveState.endedOutcome`. Unlike `turnOutcome`, the next turn beginning
   *  does not clear it. */
  endedOutcome?: TurnOutcome;

  /** How far through its own step list the session is, when it keeps one and
   *  that list is about the work it is doing now (`core/checklist.ts`). Owned
   *  sessions only — the staleness test needs the moment of the last prompt,
   *  which only the window driving a session can place. Enriches, like every
   *  other overlay: what a card makes of it is `ui/views.ts`'s business, and
   *  `status` stays the CLI's own word. */
  completion?: { total: number; completed: number };
  /** When the reader last opened this session, as the ack file's mtime
   *  (`core/acks.ts`). Machine-global like the mark itself, so every window
   *  reads the same number and a card says the same thing on every board.
   *  Absent for a session nobody has opened, one whose mark the week-long prune
   *  has swept, and one with no id to key a mark by. */
  lastSeenAt?: number;
  /** Native shutdown is pending; authored by the retained ending record. */
  closing?: true;
  /** An explicit End attempt failed. Native cleanup may still finish later. */
  endStuck?: true;
  endFailure?: string;
  startedAt: number;
  updatedAt: number;
  warm?: boolean;
  /** Since when this pipe has held its switch: the latest of the stated
   *  choice, the pipe's start and the last change of the default. A window
   *  that ended before it does not switch Warm off. */
  warmArmedAt?: number;
  /** An owned maintenance turn is currently in flight. */
  warming?: true;
  /** Our message is written and the CLI has not opened its turn: `busy`, with
   *  nothing yet for an interrupt to end. */
  turnPending?: true;
  warmPort?: import('./warm').WarmPortFacts;
  warmFailureAt?: number;
  /** Resolved cache lifetime; at is absent during ordinary busy work. */
  cache?: { ttlMs: number; source: import('./cache_ttl').TtlSource; at?: number };
  /** This session owns no terminal — the CLI's agents feature runs it under its
   *  daemon, so there is nothing to type at and no turn to end.
   *
   *  Decided at the seam by the brand that knows its own spelling for it
   *  (`core/claude/discover.ts`), never above it. Absent is interactive, and is
   *  also how a brand with no such session says so — by stating nothing. */
  background?: true;

  /** Background sessions only: what the job record says it is blocked on. */
  needs?: string;

  /** From the wire for an owned session, the transcript for a discovered one.
   *  A session whose model's window is not known reports `contextTokens`
   *  instead of `contextPct`. */
  model?: string;
  /** Owned sessions only: the alias the panel put this one on, which is a
   *  different spelling from `model` and the only one a control can name.
   *  `core/live.ts` states what it is and why it is kept. */
  modelPick?: string;
  effort?: string;
  contextPct?: number;
  contextSize?: number;
  /**
   * The window this session **last asked for**, in tokens — its launch line, or
   * the most recent mid-session switch if the reader has moved it since. Both
   * write `windowAsked`. Set whenever something asked, and not only where the
   * session ended up somewhere else.
   *
   * Absent means nothing asked, three ways — and the third is the common one:
   * a session we did not launch; one launched before the window rode the line;
   * and **an owned launch that named no window at all**, which is a typed id, a
   * stored window the model does not have (`host/sessions.ts` drops both), or
   * Grok, whose one window needs no asking (`core/live.ts:initial`). It does
   * **not** mean the ask was granted.
   *
   * Why it is filled on every ask rather than only on a mismatch, and which two
   * readers that serves: `toSession` in `core/live.ts`, on the line that fills
   * it.
   *
   * Why an ask and an outcome can differ at all: `CatalogWindow.reach` in
   * `core/catalog.ts`.
   */
  contextAsked?: number;
  /**
   * Launch reach, when observed; see WindowReach and LiveState.launchReach.
   * Keep it on Session because host/session_io.ts builds the menu from the card
   * and hands this to modelsForSession. toSession fills it through the poll.
   * Absent blocks nothing: a discovered session, a launch predating the field,
   * or an older published record. It does not mean no flag: that is plain,
   * which every start of ours states.
   */
  launchReach?: WindowReach;
  contextTokens?: number;
  /** The plan's two rate-limit windows as this session last saw them, stamped
   *  with when it saw them. The account's, not the session's — every session
   *  reports the same two, at whatever moment it last drew its status bar or
   *  last asked. `usage.mergeReadings` is what turns the several readings into
   *  the one the panel shows, and the stamps are the whole of how. */
  rateLimits?: RateLimits;
  usageGeneration?: string;

  /** The permission mode in the brand's own words — Claude's `default`,
   *  `acceptEdits`, `plan`, `auto`, `bypassPermissions`, or one of the other
   *  brands' (`CliAdapter.permissionView` maps every brand's onto the one
   *  reading a card paints). Absent until the session's first turn for Claude —
   *  nothing writes it before — and lagging a change made in the terminal by up
   *  to a couple of minutes, because the CLI snapshots it periodically rather
   *  than on change. */
  permissionMode?: string;

  /** The tool call in flight, from the frames reducer. Read by `core/awake.ts`
   *  alone, which says why. */
  activeTool?: string;

  /** Which IDE window owns the terminal this runs in, if any. */
  windowId?: string;

  /** The session that spawned this one, when a lineage record says so. Absent
   *  for a session started by hand, for one whose parent never named itself, and
   *  for one that has since `/clear`ed into a new sessionId — so a missing parent
   *  means "not known to be a child", never "root". */
  parentSessionId?: string;

  /** The fan-out this session belongs to: the session the chain of spawns
   *  opened at, carried down from each spawn rather than walked back up. So it
   *  still names gen1 for a gen3 whose gen2 has gone — which walking cannot,
   *  since `parentSessionId` is all a session records and a dismissed middle
   *  leaves no waypoint. Absent for anything not spawned by Squadron, and for
   *  anything spawned before this field existed. */
  originSessionId?: string;

  /** Where the cwd sits in git, from `git.ts` — all absent outside a repo, and
   *  absent again once that checkout goes away under the running session.
   *  `repoRoot` is the main checkout's root even for a worktree, which is what
   *  groups a worktree's sessions under the repo they were cut from — or the
   *  repository's git directory itself, where no checkout holds it (`git.ts`). */
  branch?: string;
  detached?: boolean;
  /** Read with `repoRoot`, never with `branch` — see `liveWorktree`. */
  worktree?: boolean;
  repoRoot?: string;

  /** Transcript location: stated by the wire for an owned session, else derived. */
  transcript: string;

  /**
   * `owned` is a session some window started as a child of its extension host
   * and drives over that CLI's pipe — Claude's stream-json, Grok's ACP, or
   * Codex's app-server. This window's, or another's whose published record
   * has been folded in. Absent is a twin as discovery found it: a background
   * session, the twin of an owned one before its record lands, or an
   * `sdk-cli` session nobody here started (a `claude -p`, the Agent SDK).
   *
   * It is what routes an action, not decoration: a verb on an owned session is
   * a message on its pipe, and one on anything else has nowhere to go from here.
   */
  source?: 'owned';
};

/**
 * A dev server this machine is running, as the window that started it wrote it
 * down. Alive-only: the file is removed on stop and swept on staleness, so what
 * a branch *used last* is not here — that is `ports.ts`, and it outlives this.
 *
 * Keyed by `cwd` + `runnerId`, which is what lets one directory run a dev server
 * and a Storybook at once without either being the other's second field.
 */
export type RunningServer = {
  cwd: string;
  runnerId: string;
  label: string;
  /** The branch the tree was on when it started — what the row is drawn under. */
  branch?: string;
  /**
   * The window holding the terminal. reconcileServers sweeps only this
   * window's dead records. serverContext
   * draws only terminals this window holds so another window's port becomes
   * a foreign chip rather than being claimed as ours. Stops are not requests.
   */
  windowId: string;
  port?: number;
  url?: string;
  /**
   * `starting` is written **before** the spawn, so a second window's picker sees
   * the port taken in the seconds before anything is listening on it.
   *
   * No `exited`: nothing here observes a server's process ending. A terminal
   * closed by hand removes the record, and a command that dies inside a live
   * terminal is not something the host is told about.
   */
  status: 'starting' | 'up' | 'failed';
  /** Why it failed, in the words the row prints — `port taken`, `port in use`. */
  reason?: string;
  startedAt: number;
  updatedAt: number;
};

export type WindowClaim = {
  startupAdmission?: 1;
  id: string;
  label: string;
  app: string;
  /** Workspace folder path, absent for a window with no folder open. Opening
   *  it again is the only way to raise the window that already holds it. */
  folder?: string;
  /** Always `[]` — `WindowClaimant.publish` says why it is still written. */
  shellPids: number[];
  /**
   * Publish our BRANDS for older windows, whose routed resume still reads it.
   * Local starts no longer need that lookup. Keep describing this window's
   * capabilities truthfully under the forward-only compatibility rule.
   * Absent means a running host predating this field, formerly read as Claude
   * only rather than every brand.
   */
  brands?: BrandId[];
  /**
   * `squadron.orchestrators.enabled` as this window read it at the publish:
   * how a `squadron-*` write verb learns the switch (`cli/gate.ts`). Absent
   * or not a boolean reads as off — a window predating it publishes none.
   */
  orchestration?: boolean;
  updatedAt: number;
};
