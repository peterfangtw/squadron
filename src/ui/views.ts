/**
 * The panel view-model has no vscode import. Host facts arrive as arguments
 * so grouping can be tested headlessly.
 *
 * Server rows are `server_views.ts`. Grouping still asks that module which
 * repo a directory belongs to, and which rows that group shows.
 */
import * as path from 'path';
import * as sessionTarget from '../core/session_target';
import * as cacheTtl from '../core/cache_ttl';
import { conversationKey, permissionViewOf } from '../core/adapter';
import { brandName } from '../core/accounts';
import { sessionBrand } from '../core/brands';
import { Arrangement } from '../core/arrange';
import { folds } from './fold';
import {
  isQuestion,
  PendingRequest,
  type LiveState,
  type QueuedMessage,
  type WarmTurn
} from '../core/live';
import type { StatedName } from '../core/names';
import { bestName, rungOf, sourceOf } from '../core/naming';
import { BrandId, PermissionSuggestion, Session } from '../core/model';
import type { Model } from '../core/model_names';
import * as platform from '../core/platform';
import type { PathKey } from '../core/platform/paths';
import { PublishedLive } from '../core/published';
import { delivered } from '../core/coordination/send';
import { resolve, stepList } from './reading';
import { pathHeading, shorten } from './text';
import { withoutImageMarkers } from '../core/markers';
import { sameSessionStart } from '../core/model';
import { refFor } from '../core/session_ref';
import { warmOwned } from '../core/transcript';
import * as warm from '../core/warm';
import { DEFAULT_WARM_POLICY, type WarmPolicy } from '../core/warm_policy';
import { NO_SERVERS, repoOfTree, serverRows, type ServerContext } from './server_views';

/**
 * Drop host-only fields by name, for the hazard Model.legacy states.
 * Keep effort metadata for the panel. Remove unlisted even though offeredModels
 * already drops those rows, so an upstream refactor cannot send the flag.
 */
export function modelViews(models: readonly Model[]): ModelView[] {
  return models.map(({ modalities, isDefault, unlisted, ...view }) => view);
}

/**
 * A CLI name of its own making says nothing a card does not already say: it is
 * the directory the group heading names, plus a suffix. Keep the suffix, which
 * is the only part that tells two sessions apart, and drop the rest. The real
 * title replaces it as soon as the CLI writes one.
 *
 * `nameSource` alone does not prove a name is still derived: discover takes a
 * later name from the transcript, which can carry a title while the session
 * file's `nameSource` still reads `derived`. The directory prefix is
 * the proof — and the reason this cannot just keep everything after the last
 * `-`, which would render "Understand the turn limit" as "agent-limit".
 */
export function displayName(session: Session): string {
  const name = session.name || shorten(session.cwd);
  const base = path.basename(session.cwd);
  if (session.nameSource !== 'derived' || !name.startsWith(base)) {
    return name;
  }
  const suffix = name.slice(base.length).replace(/^-/, '');
  return suffix ? `agent-${suffix}` : name;
}

/**
 * The permission mode as the footer strip says it, or nothing.
 *
 * The glyphs are the CLI's own — `⏵⏵` for the modes that let work through
 * unasked, `⏸` for the one that holds it — so a reader who has seen
 * `⏵⏵ accept edits on` under a terminal is not being taught a second vocabulary
 * for the same fact.
 *
 * The words are the **brand's**, and this asks it: three CLIs spell the same
 * three or four states four different ways, and Codex's is a policy and a
 * sandbox together rather than a word at all (`core/codex/permissions.ts`).
 * What each brand's table decides is that brand's business; what is decided
 * here is that a mode nothing has stated yet prints nothing — a card whose
 * session has not taken its first turn has no transcript to read, which is a
 * gap of seconds, not a state worth a glyph. The cost of that is that those
 * seconds look like manual on a session that launched bypassing; the
 * alternative was a mark on every fresh card, which is worse for a board that
 * is mostly fresh cards.
 *
 * **`default` is guarded here rather than left to a brand**: a table that has
 * never heard of it states it back, on a strip whose rule is that normal prints
 * nothing — every ask-mode Grok card once wore it (`--permission-mode default`).
 *
 * Claude's table maps it too and is right to — there it *is* the CLI's own word,
 * off the transcript. The two are not the same fact, which is why removing this
 * line looks safe against a brand that happens to answer the same way.
 */
export function modeView(brand: BrandId | undefined, mode: string | undefined): CardView['mode'] {
  if (mode === undefined || mode === 'default') {
    return undefined;
  }
  return permissionViewOf(brand, mode);
}

/**
 * One board out of the two halves that describe it: the sessions a window
 * drives itself, and everything `discover` found on the machine.
 *
 * They overlap. A print-mode session writes a session file like any other, so
 * discovery sees every owned session too — and makes a poor card of it: no
 * `status` field is ever written for one, so it arrives `unknown` and
 * belonging to no window. The pipe knows better about all of that, so the twin
 * goes.
 *
 * It is read on the way out for the handful of fields stated somewhere the
 * frames never reach — `withTwin`'s list, which says which and why. Everything
 * else the twin holds, the frames hold fresher.
 *
 * `published` is the same trade for a session **another** window drives. That
 * window wrote its live half down (`core/published.ts`), so a twin with a record
 * is promoted rather than left as the `unknown`, unattributed card it arrives
 * as: the published `Session` wins wholesale, since it is what `fromLive` built
 * out of the frames, and the twin contributes only what no frame can state.
 * Optional, so a caller with nothing to fold — every test of the local case,
 * and any build that reads no records — passes two arguments as before.
 *
 * `stated` is the fourth for the same reason and in the same shape: what this
 * machine's readers said a conversation should be called (`core/names.ts`), so
 * `named` below can rank it above everything either CLI has to offer.
 */
export function foldTwins(
  owned: readonly Session[],
  discovered: readonly Session[],
  published: ReadonlyMap<number, PublishedLive> = new Map(),
  stated: ReadonlyMap<string, StatedName> = new Map()
): Session[] {
  const twins = new Map(discovered.map((session) => [session.pid, session]));
  // Owned first: a new card appears before any file on disk knows about it.
  return [
    ...owned.map((session) => {
      const twin = twins.get(session.pid);
      // Before a file names the session, keep the live answer and any stated name.
      if (twin === undefined) {
        return { ...session, ...named(session, undefined, ourName(stated, session)) };
      }
      return withTwin(session, twin, ourName(stated, session));
    }),
    ...discovered
      .filter((session) => !owned.some((mine) => mine.pid === session.pid))
      .map((twin) => promote(twin, published.get(twin.pid), stated))
  ].map((session) => ({ ...session, control: sessionTarget.controlOf(session) }));
}

/**
 * Names are keyed by conversation, not pid (core/names.ts).
 * Until the CLI supplies an id, LiveState.stated carries the name.
 * The optional brand must default as routeTo does.
 */
function ourName(
  stated: ReadonlyMap<string, StatedName>,
  session: Session
): StatedName | undefined {
  return session.sessionId
    ? stated.get(conversationKey(sessionBrand(session.brand), session.sessionId))
    : undefined;
}

/**
 * Filter the board at the fold so notifications, threads and markSeen use
 * the same list: sessions owned here, or background.
 * Do not narrow foldTwins: cli/board.ts and host/waits.ts share it.
 */
export function onBoard(sessions: readonly Session[]): Session[] {
  return sessions.filter((session) => session.source === 'owned' || session.background);
}

/**
 * A live half, wearing what only its discovered twin can say about it.
 *
 * One list, called from both folds, because the two used to keep different
 * halves of it and the difference was invisible: the local fold kept `effort`
 * and `hasCommand`, while the remote one kept everything by spread — so an
 * owned card had a parent in every window except the one driving it, and the
 * family box drew in the watcher and not the owner.
 *
 * What is on the list is what no frame carries. A spawn parent and its fan-out
 * origin may already be on the owned card; the twin fills either only when
 * the card does not. The rest are what `discover` reads:
 *
 * - `effort`, out of the transcript's assistant entries — and the one entry on
 *   this list a twin may *fail* to state, so it falls back to the live half
 *   rather than overwriting it. Not every brand's discovery reads an effort:
 *   Codex's sets none while its pipe states one (`codex/session.ts`, off
 *   `thread/start`), so an unconditional take erased the live answer on every
 *   poll that found a twin — which for an owned session is every poll after
 *   the first
 * - `hasCommand`, out of the process table — a backgrounded command is a child
 *   shell of the CLI, and `fromLive` writes `false` for every session it builds
 * - `parentSessionId`, the spawn parent when the card does not already carry it
 * - `originSessionId`, the fan-out stamp, on that same rule
 * - the git fields, read off `.git` for the session's cwd — `liveWorktree`
 *   among them, because it describes the directory `branch` was read in and the
 *   two halves learn about a move at different moments: taking the branch from
 *   one and the flag from the other draws "worktree ·" over a main-checkout
 *   branch for the poll they disagree in
 * - the name, but only a stated one — `named` below
 *
 * A twin that stated a checkout still wins: Claude discover reads `.git`, and
 * that is the live directory after a worktree move. A twin that stated none
 * must not wipe the host's `readCheckout` on the owned half — Grok discover
 * is a pid with no cwd by construction, and taking that absence left every
 * Grok card with no branch.
 */
function withTwin(live: Session, twin: Session, ours?: StatedName): Session {
  const { effort, hasCommand, parentSessionId, originSessionId } = twin;
  const parent = live.parentSessionId ?? parentSessionId;
  const origin = live.originSessionId ?? originSessionId;
  const git =
    twin.branch !== undefined || twin.repoRoot !== undefined
      ? {
          branch: twin.branch,
          detached: twin.detached,
          worktree: twin.worktree,
          liveWorktree: twin.liveWorktree,
          repoRoot: twin.repoRoot
        }
      : {
          branch: live.branch,
          detached: live.detached,
          worktree: live.worktree,
          liveWorktree: live.liveWorktree,
          repoRoot: live.repoRoot
        };
  return {
    ...live,
    ...named(live, twin, ours),
    effort: effort ?? live.effort,
    hasCommand,
    ...(parent ? { parentSessionId: parent } : {}),
    ...(origin ? { originSessionId: origin } : {}),
    ...git
  };
}

/**
 * Which name a card wears once the two halves are folded together.
 *
 * The rungs and the ordering are `core/naming.ts`'s, and are the same ones
 * `core/live.ts` applies inside the pipe — one policy, so the fold can no
 * longer undo what the live half settled. What this adds is the third
 * candidate the live half cannot see: the twin, which is whatever the CLI
 * wrote into its own session file.
 *
 * The twin is listed after the live half so that a tie goes to it. That tie is
 * the case this reads a file for at all: both are `given`, the live half is
 * still printing the name it was spawned under, and a `/rename` in the CLI's
 * own UI has since written a newer one. Nothing on the pipe carries that in a
 * field, so a poll is the only way it ever arrives.
 *
 * A stated name outranks both, because it is the only rung nobody guessed and
 * because a brand may have no way of being told it at all: Grok has no rename
 * door, and Codex has one whose echo has been observed not to arrive.
 */
function named(
  settled: Session | undefined,
  twin: Session | undefined,
  ours: StatedName | undefined
): Pick<Session, 'name' | 'nameSource'> | undefined {
  const best = bestName([
    { name: settled?.name, rung: rungOf(settled?.nameSource) },
    { name: twin?.name, rung: rungOf(twin?.nameSource) },
    { name: ours?.name, rung: 'stated' }
  ]);
  return best && { name: best.name, nameSource: sourceOf(best.rung) };
}

/**
 * A discovered twin, replaced by the live half its own window published.
 *
 * The record wins wholesale: it carries `source: 'owned'`, the `windowId` that
 * makes the card addressable, and the real `status`, title, model, context,
 * permission mode and usage — none of which the twin has, since a print-mode
 * session writes no `status` field and draws no status bar.
 *
 * What the twin keeps is `withTwin`'s list — the same list the local fold keeps,
 * which is what stops the two answers drifting apart again. The spread of the
 * twin underneath is kept as well, so a field the record simply does not state
 * still survives; the named list is for the fields a `Session` really has and
 * the pipe really cannot fill.
 *
 * No record, or one that cannot be matched to this twin, leaves the twin exactly
 * as it arrives today.
 */
function promote(
  twin: Session,
  record: PublishedLive | undefined,
  stated: ReadonlyMap<string, StatedName>
): Session {
  if (
    !record ||
    record.session.pid !== twin.pid ||
    !sameSessionStart(record.session.startedAt, twin.startedAt)
  ) {
    // A stated name belongs to the conversation, even without a published half.
    return { ...twin, ...named(twin, undefined, ourName(stated, twin)) };
  }
  // Clear background explicitly: spreading an absent field would keep the twin
  // value rather than the record's answer.
  const merged: Session = {
    ...twin,
    ...record.session,
    background: record.session.background,
    windowId: record.session.windowId
  };
  // Present undefined is invalid metadata; an old publication has no key at all.
  if (!('control' in record.session)) delete merged.control;
  // Keyed off the merged card and not the twin: the record is what carries a
  // session id for a brand whose discovery cannot state one (Grok's is a pid
  // walk), and a lookup against the twin alone would miss every one of those.
  return withTwin(merged, twin, ourName(stated, merged));
}

/**
 * Parent and children are live pids; originId is the written fan-out stamp.
 * The stamp survives its origin closing. A stop walks children, not originId.
 */
export type Lineage = { parent?: number; children: number[]; originId?: string };

/**
 * Who spawned whom, over the sessions running right now.
 *
 * One rule: a session's parent is the *live* session whose `sessionId` is its
 * `parentSessionId`. No match is no parent, and the reasons are deliberately
 * indistinguishable — a parent that has closed, one that `/clear`ed itself into
 * a new id, an edge the sweep has dropped and a session nobody spawned all
 * arrive here as the same absence. Nothing downstream may read any of them as
 * "root": this states what the record says and what discovery observed, and
 * nothing between the two.
 *
 * Children are that same map inverted, so one pass produces both directions and
 * they cannot disagree. Sessions are walked in start order, which is what puts
 * every `children` list — and so every family's members — in generation order
 * without anything having to sort them again.
 *
 * `originId` is the fan-out, and it is taken from `originSessionId` exactly as
 * written — not resolved against anything. That is the difference between a
 * family that survives and one that does not: a live pid dies with its process,
 * a stamp does not, so gen3 still says gen1 after gen1 itself has closed and the
 * survivors stay one box. There is no walk to a topmost ancestor and no cycle
 * guard, because nothing here traverses an edge.
 *
 * A session with no stamp has no fan-out. Nothing backfills one from `parent`:
 * every spawn this build writes carries the stamp (`host/sessions.ts` falls back
 * to the parent's own id), so an absent one means a session an older build
 * spawned, and a lone card is the honest answer for it.
 *
 * Only sessions on one end of an edge get an entry, so `get` misses for most of
 * a board: absent and "no relations" are the same answer.
 */
export function buildLineage(sessions: Session[]): Map<number, Lineage> {
  // Keyed on the ids that are ids. A session file whose `sessionId` would not
  // parse reads as `''` (`discover.ts`) and stays on the board, so without this
  // it answers to every empty parent — one stranger adopting two.
  const live = new Map(sessions.filter((s) => s.sessionId !== '').map((s) => [s.sessionId, s.pid]));
  const lineage = new Map<number, Lineage>();
  const entry = (pid: number): Lineage => {
    const found = lineage.get(pid) ?? { children: [] };
    lineage.set(pid, found);
    return found;
  };
  for (const session of [...sessions].sort((a, b) => a.startedAt - b.startedAt)) {
    const parent =
      session.parentSessionId === undefined ? undefined : live.get(session.parentSessionId);
    if (parent !== undefined) {
      entry(session.pid).parent = parent;
      entry(parent).children.push(session.pid);
    }
    // Keep the stamp after its parent closes. An empty stamp is no fan-out.
    if (session.originSessionId !== undefined && session.originSessionId !== '') {
      entry(session.pid).originId = session.originSessionId;
    }
  }
  return lineage;
}

/**
 * One box per fan-out in this group; cards remain in the flat sessions list.
 * Explicit --parent-session-id or an older build's fallback to the parent can stamp a non-root.
 * Its card heads a box only without its own stamp, or it would draw twice.
 * An absent origin leaves the earliest member as head. Members stay in start order.
 */
function buildFamilies(
  group: Session[],
  lineage: Map<number, Lineage>,
  pidOf: Map<string, number>
): FamilyView[] | undefined {
  const byOrigin = new Map<string, number[]>();
  const startedAt = new Map<number, number>();
  const here = new Set(group.map((s) => s.pid));
  for (const session of [...group].sort((a, b) => a.startedAt - b.startedAt)) {
    startedAt.set(session.pid, session.startedAt);
    const originId = lineage.get(session.pid)?.originId;
    if (originId === undefined) {
      continue;
    }
    byOrigin.set(originId, [...(byOrigin.get(originId) ?? []), session.pid]);
  }
  if (!byOrigin.size) {
    return undefined;
  }
  const earliest = (members: number[]): number =>
    Math.min(...members.map((pid) => startedAt.get(pid) ?? 0));
  const boxes = [...byOrigin]
    .map(([originId, spawned]) => {
      const origin = pidOf.get(originId);
      const mine =
        origin !== undefined && here.has(origin) && lineage.get(origin)?.originId === undefined;
      const members = mine ? [origin, ...spawned] : spawned;
      return { parent: origin ?? members[0] ?? 0, members, headed: origin !== undefined };
    })
    // A lone survivor is loose unless its box names a live origin in another group.
    .filter((f) => f.headed || f.members.length > 1)
    .map(({ parent, members }) => ({ parent, members }));
  // Adopt a head left outside every box, or its pid would name both a loose card
  // and a box slot and orderSlots would drop the card. A pid keys at most one box.
  const boxed = new Set(boxes.flatMap((f) => f.members));
  for (const box of boxes) {
    if (here.has(box.parent) && !boxed.has(box.parent)) {
      box.members.unshift(box.parent);
    }
  }
  // Sorted after the adoption, which changes what a box's earliest member is.
  boxes.sort((a, b) => earliest(a.members) - earliest(b.members) || a.parent - b.parent);
  // Undefined, not empty: a dissolved last box reads as a group that never had one.
  return boxes.length ? boxes : undefined;
}

/**
 * The group's top-level slots in render order — the stored ones first, then
 * every slot the arrangement does not name, in the order the board derives.
 * There is no merge rule, because the derived rule already puts the newest last:
 * a session that started after the drag appends, exactly where its add-card was.
 *
 * A slot is a loose card's pid or the pid of the card a family is headed by, and
 * the two cannot collide — a card is drawn in exactly one place, and a head in
 * this group is always inside a box, its own or the one it was adopted into
 * (`buildFamilies`). So this is a
 * flat list of pids with nothing tagging which kind each is; the renderer knows,
 * because it has the families.
 *
 * `startedAt` guards every placement at the same 5 s tolerance `promote` uses.
 * The hazard is identical: a pid the kernel handed to something else after the
 * session that was dragged died. Without the guard, an arrangement would place
 * an unrelated card wherever the dead one sat, which is worse than not
 * remembering at all.
 *
 * Returns `undefined` when this group has never been arranged, so `slots` stays
 * off the payload and the webview falls through to the render path it has.
 */
function orderSlots(
  group: Session[],
  families: FamilyView[] | undefined,
  stored: Arrangement | undefined,
  startedAt: Map<number, number>
): number[] | undefined {
  if (!stored) {
    return undefined;
  }
  const boxed = new Set((families ?? []).flatMap((f) => f.members));
  const derived = [
    ...[...group]
      .filter((s) => !boxed.has(s.pid))
      .sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)
      .map((s) => s.pid),
    ...(families ?? []).map((f) => f.parent)
  ];

  const live = new Set(derived);
  const placed = new Set<number>();
  const head: number[] = [];
  for (const slot of stored.slots) {
    // Ignore hand-edited duplicates to avoid drawing one card twice.
    if (!live.has(slot.pid) || placed.has(slot.pid)) {
      continue;
    }
    if (!sameSessionStart(startedAt.get(slot.pid), slot.startedAt)) {
      continue;
    }
    placed.add(slot.pid);
    head.push(slot.pid);
  }
  return [...head, ...derived.filter((pid) => !placed.has(pid))];
}

/** The lifetime a card's clock runs on: the one the session was timed against,
 *  else its brand's default. */
function cacheTtlMs(session: Session): number {
  const stated = session.cache?.ttlMs;
  return cacheTtl.validTtl(stated)
    ? stated
    : DEFAULT_WARM_POLICY.ttlMs[sessionBrand(session.brand)];
}

export function toCard(session: Session, lineage?: Lineage): CardView {
  const control = sessionTarget.controlOf(session);
  return {
    pid: session.pid,
    name: displayName(session),
    fullCwd: session.cwd,
    ...(session.transcript ? { ref: refFor(session.pid, session.transcript) } : {}),
    // Where the process stands, when that is not where it started. Stated only
    // when it differs, like `Session.liveCwd` itself: the composer's clip opens
    // its dialog here, and `host/session_io.ts` has the measurement.
    ...(session.liveCwd === undefined ? {} : { liveCwd: session.liveCwd }),
    status: session.status,
    ...(session.warming && !session.closing ? { warming: session.warming } : {}),
    ...(session.turnPending ? { turnPending: true as const } : {}),
    // The chip is the remaining display of running commands.
    hasCommand: session.hasCommand,
    waitingFor: session.waitingFor,
    completion: stepList(session),
    // ui/reading.ts ranks these facts; do not gate them here.
    ...resolve({
      status: session.status,
      waitingFor: session.waitingFor,
      completion: session.completion,
      // Whether what this session finished has been seen — a statement about
      // **delivery**, which every session gets, not only the few that keep a
      // list. Never clicked reads `idle`, deliberately: otherwise the first
      // poll after install turns every idle card on the machine green at once.
      //
      // `session.updatedAt` raw, not the `|| startedAt` the field below ships:
      // a session file written before its first status flip has no
      // `updatedAt`, and dating that to the start would let a session that has
      // replied to nobody claim it had.
      //
      // That clock is "when it last did something" for every source: a
      // discovered session's is the CLI's own `statusUpdatedAt`; an owned
      // session's is bumped by `host/sessions.ts` on a prompt or the session's
      // own change, never on the panel's bookkeeping.
      neverSeen: session.lastSeenAt === undefined,
      unseen: session.lastSeenAt !== undefined && session.updatedAt > session.lastSeenAt,
      turnOutcome: session.turnOutcome
    }),
    closing: session.closing,
    endStuck: session.endStuck,
    endFailure: session.endFailure,
    // Invalid routing data must not remove an owned card's close/dismiss control.
    canControl: control.canControl || control.reason === 'invalid',
    // Ownership removes buttons; it does not change the card's reading.
    owned: session.source === 'owned' || undefined,
    needs: session.needs,
    model: session.model,
    modelPick: session.modelPick,
    brand: session.brand,
    effort: session.effort,
    contextPct: session.contextPct,
    contextSize: session.contextSize,
    contextAsked: session.contextAsked,
    contextTokens: session.contextTokens,
    startedAt: session.startedAt,
    // A session file written before its first status flip carries no
    // `updatedAt`, and discover reads that as zero; the start is the truest
    // thing left to say, and it keeps a card off 1970.
    updatedAt: session.updatedAt || session.startedAt,
    cacheFrom: session.cache?.at,
    cacheUntil: cacheTtl.cacheUntil(session),
    cacheTtlMs: cacheTtlMs(session),
    // Use the session branch; repoRoot only decides its group.
    branch: session.branch,
    detached: session.detached,
    // Chip flag matches the branch beside it (`Session.liveWorktree`).
    worktree: session.liveWorktree ?? session.worktree,
    mode: modeView(session.brand, session.permissionMode),
    // Use live pids so the webview reads names from the related cards.
    parent: lineage?.parent,
    children: lineage?.children.length ? lineage.children : undefined
  };
}

/**
 * Keeping a session's prompt cache warm, as the panel lists it: the switch, the
 * lifetime the pings are timed against and where that figure came from, and
 * the scheduler's own answer — the next ping, or why there is none. One read of
 * `warmDue`, the function `host/warm.ts` acts on, so the list cannot promise a
 * ping the scheduler has held. Apart from `toCard`, which has no clock and
 * also feeds the thread and `squadron-list`.
 */
export function warmView(session: Session, now: number, policy: WarmPolicy): WarmView {
  const decision = warm.warmDue(session, session.warmPort, session.warmFailureAt, now, policy);
  const ttl = session.cache ?? cacheTtl.ttlFor(sessionBrand(session.brand), policy);
  return {
    on: session.warm === true,
    ttlMs: ttl.ttlMs,
    source: ttl.source,
    nextAt: decision.due ? now : decision.nextAt,
    endsAt: warm.warmEndsAt(session, policy),
    held: decision.held
  };
}

/** What the panel resolves for a thread and this cannot: pipes, files, markup. */
export type ThreadInputs = {
  historyState?: 'loading' | 'failed';
  /** Whether some window can write to it — the panel resolves the pipe. */
  reachable: boolean;
  /**
   * Pass exited; do not derive it from owned and unreachable.
   * A remote window that stops publishing can leave its session running.
   */
  exited?: boolean;
  exchanges: ExchangeView[];
  truncated?: boolean;
  /** Drawn off the CLI's transcript rather than our own record — see
   *  `ThreadView.fallback`. */
  fallback?: true;
  /** Held outbox rows for an owned session. Absent when empty or for a session
   *  with no send path. */
  queued?: Pick<QueuedMessage, 'id' | 'text' | 'images' | 'parts'>[];
  /** The row that just left the outbox. Its parts retire against their own
   *  recorded turns; `queuedAt` excludes older copies of the same words. */
  inFlight?: QueuedMessage;
  /** Every request an owned session is blocked on, oldest first. */
  pending?: readonly PendingRequest[];
  /** Lineage from the whole poll: this single-session fold cannot find the parent. */
  lineage?: Lineage;
  /** Start-model rows this session's brand owns. The gear keeps the union. */
  models?: readonly Model[];
  /** Whether this thread can select a target for its next message. */
  canModel?: boolean;
  /** What this session can load, for the composer's `@` menu. From its own
   *  `init` where it has had one, else what this window learnt from another
   *  session in the same directory — the caller resolves which, since neither
   *  source is a single session's to read. Absent for a background session —
   *  it has no `init` to read them off — which is
   *  what makes absence the trigger's own test. */
  skills?: readonly string[];
  /**
   * Workflow provenance for the composer and observe drawer, never cards.
   * Phase comes from rollup(); the host join supplies the full snapshot rail.
   */
  workflow?: {
    label: string;
    phase: 'running' | 'done' | 'failed';
    step?: { label: string; tone: 'working' | 'done' | 'failed' };
    steps?: {
      id: string;
      label: string;
      status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'unknown';
      note?: string;
      current?: boolean;
    }[];
  };
};

/**
 * Name every place an always-allow writes. If any suggestion's brand could not
 * name it, drop the button so its label cannot understate what it writes.
 */
function alwaysLabel(suggestions?: readonly PermissionSuggestion[]): string | undefined {
  if (!suggestions?.length) {
    return undefined;
  }
  const where = suggestions.map((s) => s.where);
  return where.every((w) => w !== undefined) ? [...new Set(where)].join(' · ') : undefined;
}

/**
 * How much of a tool's input the dock is shown. A `Write` is the call that
 * prompts most often and carries the whole file in `content`, and this rides on
 * every state push for as long as the request is open — so it is trimmed here
 * rather than hidden with CSS at the far end of a `postMessage`.
 */
const MAX_INPUT = 4000;

function formatInput(input?: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(input ?? {}, null, 2);
  } catch {
    // A cycle, or something else `JSON.stringify` will not take. The card still
    // has a label and its buttons; what it loses is the detail.
    return '';
  }
  return text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) + '\n…' : text;
}

/** Render unparsed questions as a permission prompt so an answer remains possible. */
function toPendingView(request: PendingRequest): PendingRequestView {
  if (isQuestion(request)) {
    return {
      requestId: request.requestId,
      kind: 'ask',
      questions: request.questions,
      ...(request.canNote === false ? { canNote: false } : {}),
      ...(request.canReply === false ? { canReply: false } : {})
    };
  }
  return {
    requestId: request.requestId,
    kind: 'permission',
    toolName: request.toolName,
    label: request.ask
      ? 'A question this panel could not read'
      : (request.label ?? request.toolName),
    input: formatInput(request.input),
    ...(request.canDenyReason === false ? { canDenyReason: false } : {}),
    always: request.ask ? undefined : alwaysLabel(request.suggestions)
  };
}

/**
 * The messages we have written but not yet read back, unless the transcript has
 * caught up with them. Matched by the words, since our outbox row and the CLI's
 * entry share no id. The rule itself is `chat.ts`'s `sameWords`.
 *
 * **Backwards, stopping at the first turn older than the send**, which is the
 * whole of what keeps it honest. Asked of the tail as a whole, a message whose
 * words have been sent before is retired against its own earlier copy on the
 * very poll it was created — "continue" twice, or two of any slash command, and
 * the gap this exists to fill is blank again. Only what the CLI wrote down
 * after we queued this one can be this one.
 *
 * A slash command never lands as a turn at all — the CLI writes scaffolding and
 * the reader sees a chip — so the chip settles it, by name, since the arguments
 * are written as an entry of their own. Chips carry no stamp, which is why they
 * do not end the walk: they are read only inside the window a stamped turn
 * already bounded.
 *
 * A cache-warming ping is never one: nobody said it, and the thread's own warm
 * turn is its only drawing.
 */
function stillSending(
  inFlight: QueuedMessage | undefined,
  exchanges: readonly ExchangeView[]
): QueuedView[] {
  if (!inFlight || inFlight.warm) return [];
  const matched = new Set<number>();
  const rows = (inFlight.parts ?? [inFlight]).map((part) => ({
    row: outboxRow({
      id: part.id,
      text: part.text,
      images: part.images?.length || undefined
    }),
    // Wrapped wire text cannot be a slash command, even when its body is one.
    named: part.text.trim().split(/\s+/)[0]
  }));
  const settled = new Set<number>();
  // Reserve exact receipts across the batch before allowing attachment suffixes.
  for (const suffix of [false, true]) {
    for (const [index, { row, named }] of rows.entries()) {
      if (settled.has(index)) continue;
      const author = row.role ?? 'user';
      const words = withoutImageMarkers(row.text).trim();
      let match: number | undefined;
      for (let i = exchanges.length - 1; i >= 0; i--) {
        const x = exchanges[i];
        if (!x || matched.has(i)) {
          continue;
        }
        if ('mark' in x) {
          if (x.by === 'you' && !!x.skill && named === '/' + x.skill) {
            match = i;
            break;
          }
          continue;
        }
        if (x.at !== undefined && x.at < inFlight.queuedAt) {
          break; // written before this message was, so nothing older is it
        }
        const said = withoutImageMarkers(x.text).trim();
        if (x.role !== author || x.from !== row.from) continue;
        if (said === words || (suffix && said.startsWith(words + '\n'))) {
          match = i;
          break;
        }
      }
      if (match !== undefined) {
        matched.add(match);
        settled.add(index);
      }
    }
  }
  return rows.flatMap(({ row }, index) => (settled.has(index) ? [] : [row]));
}

/**
 * One outbox row as the dock draws it: the words without the envelope, and the
 * author those words name.
 *
 * **The outbox holds what went on the wire**, which for the two wrappers is not
 * what anybody said. Every other reader of a delivered text takes the envelope
 * off — both records do, on the way in — and this list was the one that did
 * not, so a resolution drew as the reader's own turn with `<squadron-wait>`
 * in the body and then never retired against the turn the record filed it as.
 * Observed at the panel, 2026-08-22; `src/test/live_session/wait_convergence.md`.
 *
 * Spread rather than rebuilt field by field, so a field added to `QueuedView`
 * later survives the wrapped path — which is the rarest one, and so the last
 * place a dropped field would be found.
 */
function outboxRow(row: QueuedView): QueuedView {
  const said = delivered(row.text);
  const drawn: QueuedView = { ...row, text: said.text };
  if (said.role === 'wait') {
    drawn.role = said.role;
  }
  if (said.from !== undefined) {
    drawn.from = said.from;
  }
  return drawn;
}

/** Paint-only: the dock's assistant label. Not a verb gate. */
function assistantWho(brand: Session['brand']): string {
  return brandName(sessionBrand(brand));
}

/** The two halves a dock thread is drawn from, each read once by the caller. */
export type ThreadHalves = {
  /** The session's turns, rendered: its thread in memory for one this window
   *  drives, else our record or the CLI's own history (`fallback`). */
  history: {
    echoEvidence?: EchoEvidence[];
    historyState?: 'loading' | 'failed';
    exchanges: ExchangeView[];
    truncated?: boolean;
    fallback?: true;
    /** Messages still being written, each drawn before the turn at `position`
     *  in `exchanges` (`TailRow`, `core/thread.ts`). */
    tail?: readonly { position: number; exchange: ExchangeView }[];
  };
  /** This window's own live half, or nothing for a session it holds no pipe
   *  to. Taken in the same instant as `history`; nothing below reads a
   *  fresher one. */
  live: LiveState | undefined;
};

/** What the host knows about the open session beyond its two halves. */
export type ThreadContext = Pick<ThreadInputs, 'lineage' | 'workflow' | 'canModel' | 'models'> & {
  /** Folder discoveries resolved for the actual cwd and CLI. */
  skillsHere?: readonly string[];
};

/**
 * The dock's thread out of one reading of history and one of the live half:
 * which live fields join the read-back turns, and what each is drawn as.
 *
 * Pure, so that what the host composes is what a test composes —
 * `thread_trace.test.ts` replays real wire traces through it.
 */
export function composeThread(
  session: Session,
  { history, live }: ThreadHalves,
  context: ThreadContext
): ThreadView {
  const reachable = session.source === 'owned' && live !== undefined && live.exit === undefined;
  return toThread(session, {
    reachable,
    // Its child has gone, as against its window having stopped saying so.
    exited: live?.exit !== undefined,
    exchanges: foldWarm(withTail(history.exchanges, history.tail), live?.warmTurn),
    historyState: history.historyState,
    truncated: history.truncated,
    fallback: history.fallback,
    queued: live?.queued,
    // Written and not yet read back, and this window's own half only. A window
    // one along reads the record and the transcript in the same pass, and the
    // CLI writes its copy of a message on receipt — so by the time a publish
    // has dropped the row there, the turn is already in the file it reads. The
    // gap is ours alone: our own state pops the row and repaints on the same tick.
    inFlight: live?.inFlight,
    // The requests the session is blocked on, straight off its pipe — the
    // only place a question the panel can answer ever comes from.
    pending: live?.pending,
    lineage: context.lineage,
    skills: live && !session.background ? context.skillsHere : undefined,
    workflow: context.workflow,
    canModel: context.canModel,
    models: context.models
  });
}

/**
 * Turns with each message still being written drawn where it stands, marked
 * so the webview paints it as the row still growing. A row's `position` counts
 * the turns before it, so each one drawn moves the next one along.
 */
function withTail(
  exchanges: ExchangeView[],
  tail: NonNullable<ThreadHalves['history']['tail']> = []
): ExchangeView[] {
  if (!tail.length) return exchanges;
  const drawn = [...exchanges];
  tail.forEach((row, already) => {
    drawn.splice(row.position + already, 0, { ...row.exchange, streaming: true });
  });
  return drawn;
}

/**
 * Each cache-warming ping as the one row the reader is owed, saying how it went
 * — never the prompt we wrote, and never the model's "OK".
 *
 * `groupWarmReplies` decides which rows belong to a ping. `projectWarmVerdict`
 * decides what that ping says and which of those rows stay. A correlated row is
 * drawn under its ping, in the order the replies were met.
 */
function foldWarm(exchanges: ExchangeView[], latest?: WarmTurn): ExchangeView[] {
  const pings = exchanges.flatMap((x, at) => ('mark' in x || x.role !== 'warm' ? [] : [at]));
  const newest = pings.at(-1);
  if (newest === undefined) return exchanges;
  const { replies, correlated } = groupWarmReplies(exchanges, pings);
  const drawn: ExchangeView[] = [];
  for (let at = 0; at < exchanges.length; at++) {
    const row = exchanges[at];
    if (row === undefined || correlated.has(at)) continue;
    if ('mark' in row || row.role !== 'warm') {
      drawn.push(row);
      continue;
    }
    drawn.push(...projectWarmVerdict(row, replies.get(at) ?? [], latest, at === newest));
  }
  return drawn;
}

/**
 * Which rows a ping owns. Named id first, then the anonymous span `warmOwned`
 * still holds. One forward pass; the draw walk does not decide this again.
 */
function groupWarmReplies(
  exchanges: readonly ExchangeView[],
  pings: readonly number[]
): { replies: Map<number, ExchangeView[]>; correlated: Set<number> } {
  const owned = warmOwned(exchanges);
  const named = new Map<string, number>();
  for (const at of pings) {
    const ping = exchanges[at];
    if (ping && 'role' in ping && ping.warmId) named.set(ping.warmId, at);
  }
  const replies = new Map<number, ExchangeView[]>();
  const correlated = new Set<number>();
  let legacy: number | undefined;
  for (let at = 0; at < exchanges.length; at++) {
    const row = exchanges[at];
    if (!row) continue;
    if ('role' in row && row.role === 'warm') {
      legacy = row.warmId ? undefined : at;
      continue;
    }
    const owner =
      'role' in row && row.warmId
        ? row.maintenance === false
          ? undefined
          : named.get(row.warmId)
        : owned[at]
          ? legacy
          : undefined;
    if (!owned[at]) legacy = undefined;
    if (owner === undefined) continue;
    const group = replies.get(owner) ?? [];
    group.push(row);
    replies.set(owner, group);
    correlated.add(at);
  }
  return { replies, correlated };
}

/**
 * A clean reply is dropped. Anything else the span holds — a call the model
 * reached for, the CLI's own error, a reply cut short — is evidence, so it stays
 * and the row says the ping missed. `latest` speaks for the newest ping alone:
 * an older one has settled, and a latch id that names a different ping does not
 * replace this one. Either side having no id still uses the latch. A row still
 * streaming is the ping still out, latch or none.
 */
function projectWarmVerdict(
  ping: AuthoredView,
  answers: readonly ExchangeView[],
  latest: WarmTurn | undefined,
  newest: boolean
): ExchangeView[] {
  const kept = answers.filter((x) => 'mark' in x || !cleanReply(x));
  const live =
    newest && (!latest?.id || !ping.warmId || latest.id === ping.warmId) ? latest : undefined;
  const latch = live ?? ping.warmEvidence;
  const verdict = latch ? warm.warmVerdict(latch) : undefined;
  const out =
    live?.phase === 'written' ||
    live?.phase === 'open' ||
    answers.some((x) => 'streaming' in x && x.streaming);
  const missed =
    latch?.failed === true ||
    verdict === 'miss' ||
    (latch?.trafficAt === undefined &&
      !(ping.warmId && verdict === 'hit') &&
      !answers.some((x) => !('mark' in x) && cleanReply(x))) ||
    kept.some((x) => !('mark' in x));
  const said = out ? WARMING : missed ? MISSED : verdict === 'hit' ? KEPT : UNCONFIRMED;
  return [
    { ...ping, text: said, blocks: [{ prose: said }] },
    ...kept.map((x) => ('mark' in x ? x : { ...x, maintenance: true }))
  ];
}

const WARMING = 'Warming the prompt cache';
const KEPT = '✓ Kept the prompt cache warm';
const MISSED = '✗ Cache warm failed';
const UNCONFIRMED = 'Prompt cache reuse unconfirmed';

/** The model answering a ping as asked: prose and nothing else, all of it. */
function cleanReply(x: AuthoredView): boolean {
  return (
    x.role === 'assistant' &&
    !x.cut &&
    !x.images?.length &&
    !x.files?.length &&
    x.blocks.every((block) => !('summary' in block))
  );
}

/**
 * The open session and its recent turns. Match panel.send: a pipe gates sends;
 * busy and waiting hold messages. Background sessions remain readable.
 */
export function toThread(session: Session, inputs: ThreadInputs): ThreadView {
  const control = sessionTarget.controlOf(session);
  const isBackground = !control.canControl && control.reason === 'background';
  // See ThreadInputs.exited: unreachable does not mean ended.
  const ended = inputs.exited === true;
  const canSend = control.canControl && inputs.reachable && !ended && !session.closing;
  const card = toCard(session, inputs.lineage);
  // A turn folds only when status, the words being written and pending requests
  // are all finished.
  const running =
    card.status === 'busy' ||
    inputs.exchanges.some((x) => 'streaming' in x && x.streaming) ||
    !!inputs.pending?.length;
  const folded = folds(inputs.exchanges, running);
  const sending = stillSending(inputs.inFlight, inputs.exchanges);
  // Dismiss takes the whole queued delivery; sending rows keep their part ids.
  const queued = (inputs.queued ?? []).flatMap(({ id, text, images, parts }) =>
    (parts ?? [{ text, images }]).map((part) =>
      outboxRow({
        id,
        text: part.text,
        ...(part.images?.length ? { images: part.images.length } : {})
      })
    )
  );
  return {
    ...card,
    // Workflow provenance belongs in the dock, not on every card.
    ...(inputs.workflow ? { workflow: inputs.workflow } : {}),
    exchanges: inputs.exchanges,
    historyState: inputs.historyState,
    folds: folded.length ? folded : undefined,
    truncated: inputs.truncated,
    fallback: inputs.fallback,
    // Copy skills to keep the view mutable without sharing state.
    // Drop an empty list because it offers no menu.
    skills: inputs.skills?.length ? [...inputs.skills] : undefined,
    // Held outbox is already the truth — no text-match retire against the thread.
    queued: queued.length ? queued : undefined,
    sending: sending.length ? sending : undefined,
    pending: inputs.pending?.length ? inputs.pending.map(toPendingView) : undefined,
    // Background sessions cannot send, regardless of caller reachability.
    canSend,
    // Absent `images` is Claude's default (and every record written before
    // the field existed). A brand that cannot take them states `false`.
    canAttach: canSend && session.images !== false,
    who: assistantWho(session.brand),
    // Stated only when true, like every other optional above it. The composer
    // is the reader: a refusal it is holding yields to `blockedReason` here and
    // nowhere else — see `chat.ts`.
    ...(ended ? { ended: true } : {}),
    ...(inputs.canModel === false ? { canModel: false as const } : {}),
    ...(inputs.models?.length ? { models: modelViews(inputs.models) } : {}),
    blockedReason: isBackground
      ? 'Background session — it has no controllable pipe.'
      : ended
        ? 'Ended. Its turns are kept here until you close the card.'
        : canSend
          ? undefined
          : 'No window is publishing a way in, so nothing here can reach it.'
  };
}

/** Match host/runs.ts group keys, or a server can have no row and no way to stop. */
export function groupKey(session: Pick<Session, 'cwd' | 'worktree' | 'repoRoot'>): string {
  return (session.worktree && session.repoRoot) || session.cwd;
}

/**
 * Group by cwd: window claims cover only Squadron windows and would bury most
 * sessions in an outside bucket; every session has a cwd.
 * Fold only worktrees into their repo; repoRoot alone would merge sibling apps.
 * Use git's answer, not containment, so external worktrees fold too.
 * folderRoots applies the same fold to this window's folder when it has no session.
 * Seed this window's folder and server repos; other session cwds form their own groups.
 * One group per path key, headed by the first spelling seen: this window's
 * folder, then sessions in order, then servers. That string is the group's `cwd`
 * on the wire, so the webview only ever joins strings the host chose.
 */
export function buildGroups(
  sessions: Session[],
  workspaceFolder: string | undefined,
  folderRoots: Map<string, string> = new Map(),
  arrangements: Map<PathKey, Arrangement> = new Map(),
  servers: ServerContext = NO_SERVERS
): GroupView[] {
  // Build lineage over the whole board: families can span groups.
  const lineage = buildLineage(sessions);
  // Include other groups' parents when guarding slots by start time.
  const startedAt = new Map(sessions.map((s) => [s.pid, s.startedAt]));
  // What turns a stamp back into a card, when the session it names is still
  // running. Machine-wide, because the card that heads a box can be in another
  // group — and empty ids are nobody, exactly as in `buildLineage`.
  //
  // Oldest wins where two live sessions claim one id, which `claude --resume`
  // can produce: the elder is the one the fan-out was stamped against, and
  // last-wins would hand the box to whichever the directory listing named last.
  const pidOf = new Map<string, number>();
  for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt)) {
    if (s.sessionId !== '' && !pidOf.has(s.sessionId)) {
      pidOf.set(s.sessionId, s.pid);
    }
  }

  const byCwd = new Map<PathKey, { cwd: string; sessions: Session[] }>();
  const join = (cwd: string): Session[] => {
    const key = platform.paths.key(cwd);
    let group = byCwd.get(key);
    if (!group) {
      group = { cwd, sessions: [] };
      byCwd.set(key, group);
    }
    return group.sessions;
  };
  // This window's own folder, always — read from the host rather than from its
  // claim on disk. `host/windows.ts` republishes on a 30s beat, never on
  // `onDidChangeWorkspaceFolders`, so a claim can name a folder this window has
  // since left. The heading follows the window, not the file.
  const workspaceRoot =
    workspaceFolder === undefined
      ? undefined
      : (folderRoots.get(workspaceFolder) ?? workspaceFolder);
  if (workspaceRoot !== undefined) {
    join(workspaceRoot);
  }
  for (const session of sessions) {
    join(groupKey(session)).push(session);
  }
  // Keep a heading for live servers with no cards so they can still be stopped.
  for (const server of servers.running) {
    join(repoOfTree(server.cwd, servers) ?? server.cwd);
  }
  const home = workspaceRoot === undefined ? undefined : platform.paths.key(workspaceRoot);
  const isHome = (cwd: string) => platform.paths.key(cwd) === home;

  return (
    [...byCwd]
      .map(([key, { cwd, sessions: group }]) => {
        const families = buildFamilies(group, lineage, pidOf);
        return {
          ...pathHeading(cwd),
          cwd,
          sessions: group.map((s) => toCard(s, lineage.get(s.pid))),
          families,
          slots: orderSlots(group, families, arrangements.get(key), startedAt),
          servers: serverRows(cwd, servers)
        };
      })
      // Sort by this window's folder then path, so session churn does not move headings.
      .sort((a, b) => Number(isHome(b.cwd)) - Number(isHome(a.cwd)) || a.cwd.localeCompare(b.cwd))
  );
}

/**
 * Newly waiting sessions, matched by pid; an absent prior pid counts.
 * The caller withholds the first snapshot because it has no prior to diff.
 */
export function newlyWaiting(previous: Session[], next: Session[]): Session[] {
  const wasWaiting = new Set(previous.filter((s) => s.status === 'waiting').map((s) => s.pid));
  return next.filter((s) => s.status === 'waiting' && !wasWaiting.has(s.pid));
}

/**
 * The one cue a poll is worth, or nothing. `blocked` outranks `done` because
 * only one of the two is waiting on a person, and because two cues fired
 * together are heard as neither.
 *
 * One per tick, not one per session: N sessions finishing on the same poll is
 * the common case for a board of subagents, and N overlapping beeps is noise.
 *
 * `done` is a `busy` that became `idle`, and takes the opposite edge case to
 * `newlyWaiting`: a pid absent from the prior snapshot does *not* count. A
 * session that appeared already blocked still wants a person; one first seen
 * idle finished before the panel was watching.
 */
export function soundCue(previous: Session[], next: Session[]): SoundCue | undefined {
  if (newlyWaiting(previous, next).length > 0) return 'blocked';
  const wasBusy = new Set(previous.filter((s) => s.status === 'busy').map((s) => s.pid));
  return next.some((s) => s.status === 'idle' && wasBusy.has(s.pid)) ? 'done' : undefined;
}
