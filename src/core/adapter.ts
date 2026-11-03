/**
 * The CLI brand seam: one registry entry and one directory implementing these types.
 * Adapters contain CLI spellings so ui/ can work in Session, LiveState, Model
 * and Exchange without brand checks (root AGENTS.md).
 * These are ports, not wire formats: no adapter is asked to serialise them.
 * No two adapters talk to each other; the host calls them by name.
 */

import { BRANDS, isBrand, sessionBrand } from './brands';
import { brandName, type AccountRowStatus } from './accounts';
import type { ChangeOrigin } from './activity';
import { claudeAdapter } from './claude/adapter';
import { codexAdapter } from './codex/adapter';
import { grokAdapter } from './grok/adapter';
import type { BinaryFound, BinaryMissing } from './bin';
import type { Program } from './platform/executables';
import { reachableFrom } from './catalog';
import type { HeadPass } from './git';
import type { ProcessTable } from './scan';
import type { PassEvidence } from './published';
import type { LiveState } from './live';
import type {
  BrandId,
  Decision,
  ImageBlock,
  RateLimits,
  SendTarget,
  Session,
  WindowReach
} from './model';
import type { Model } from './model_names';
import { asStated, type PermissionView } from './permissions';
import * as transcriptAttribution from './transcript_attribution';
import { conversationKey } from './identity';
import type { ExecutionIntegration, ExecutionRuntime } from './execution';
import { drawableFor, NO_WITNESS, readRecord } from './record';
import type { SessionTransport } from './session';
import type { ThreadSnapshot } from './thread';
import type { Recent } from './transcript';

export { conversationKey } from './identity';
export { brandForModel } from './model_names';

/** Error vocabulary for a refused operation, not an inventory of live ports. */
export type Capability = 'messages' | 'turn' | 'model' | 'naming' | 'asks' | 'warm';

export { advancesActivityClock, advancesCacheClock, type ChangeOrigin } from './activity';

/** Whether a ping went on the pipe, or why it did not. Accepted is not proof
 *  the cache was warmed: `warmVerdict` reads that off the turn. */
export type WarmAttempt = { ok: true } | { ok: false; reason: string };

/**
 * Capabilities are objects, not flags beside differently named methods.
 * A caller with the object can call its methods; one without it cannot compile
 * the call. This keeps support and callability together.
 * A partly supported verb leaves the group off and is refused by name, to
 * prevent a verb being offered and then dropped.
 */
export interface SessionHandle {
  readonly state: LiveState;
  /** Every change. A failed write can retain its real-activity origin while
   *  cacheTraffic denies evidence of API traffic. observedAt retains receipt
   *  time when native ownership is confirmed after a notification arrived. */
  onChange(
    listener: (
      state: LiveState,
      origin: ChangeOrigin,
      cacheTraffic?: boolean,
      observedAt?: number
    ) => void
  ): () => void;
  /**
   * Agent text received, every delta. Its words are the thread's and an open
   * turn's card state stays the same object across them, so `onChange` says
   * nothing — but the session is at work, and the card's activity clock is
   * told so here. Never a resolved checkpoint, a recovery landing, or text a
   * close already ended.
   */
  onActivity(listener: (observedAt?: number) => void): () => void;
  /** End the session. Every brand can be ended; that is what makes it a card. */
  close(): void;
  /**
   * Await local record/capture writes, before the host exits. After `close`
   * it finalises the thread (`Thread.finish`): the host will not wait for the
   * child's output to close, which is what ends it otherwise.
   */
  flush?(): Promise<void>;
  /**
   * A command the panel answered itself, drawn as a slash command's answer is
   * (`localReply`). Queued on this session's own record append chain, so it lands
   * between the turns it happened between. It reaches no CLI and starts no turn.
   */
  readout(text: string): void;
  /** The handle can safely accept a prompt, including local queuing.
   * Claude needs no native init; the prompt itself starts that exchange. */
  readonly opening: Promise<{ ok: true } | { ok: false; reason: string; cause?: 'pick' }>;
  /**
   * The conversation as this window holds it in memory (`core/thread.ts`).
   *
   * A port on the handle and not on `CliAdapter`, because recovering what came
   * before the pipe reads through the session: Codex's history is a request on
   * the app-server this handle already holds, and a second one started to read
   * it would contend for the thread it is driving.
   *
   * `recovered` settles once the baseline — our record if `drawable`, else the
   * brand's history — has landed, or been given up on (`recoverBaseline`). The
   * first send waits on it, so history and the pipe never hold one turn
   * between them twice. It never rejects, and answers false when it gave up:
   * memory then holds the pipe and nothing before it.
   *
   * The dock and End read an owned session here and nowhere else
   * (`ownedTranscript`, `hasExchanges`): its record and the CLI's history are
   * read once, by that recovery, and never per refresh.
   */
  readonly thread: {
    readonly historyState?: 'loading' | 'failed';
    generation(): number;
    snapshot(): ThreadSnapshot;
    readonly recovered: Promise<boolean>;
    /** `Thread.onChange`: the snapshot may have moved. */
    onChange(listener: () => void): () => void;
  };

  /**
   * Writing to the session, and the outbox that holds what is not written yet.
   * The queue is the panel's rather than the CLI's, so a brand that can be sent
   * to can also dismiss a held row and flush the lot.
   */
  readonly messages?: {
    /** Images may ride inline in a message. False turns the composer's clip
     *  off rather than writing a file and a path the CLI cannot read. */
    readonly images: boolean;
    /** Whether a send now would wait behind the outbox or this handle's drain latches.
     * Asked before send: baseline capture can keep an outgoing row queued after it returns. */
    pending(): boolean;
    /** `ahead` puts the message at the head of the outbox, for the drain that
     *  follows an interrupt. Everything else appends. `target` selects the supported
     *  model/window/effort for this message before its prompt is written. */
    send(
      text: string,
      images?: readonly ImageBlock[],
      describe?: string,
      ahead?: boolean,
      target?: SendTarget,
      correlation?: string
    ): void | Promise<void>;
    dismiss(id: string): boolean;
    sendNow(): Promise<void>;
  };
  /** Ending the turn that is running, leaving the session at its prompt. */
  readonly turn?: { interrupt(): Promise<void> };
  /** Moving the session onto another model from its next turn. */
  /** `window` is the tokens of the row pressed, a request rather than a promise
   *  — a running session's window moves only where its launch line left room.
   *  A brand with one window ignores it. */
  readonly model?: { set(model: string, window?: number): Promise<void> };
  /**
   * Telling **this CLI** what the session is now called.
   *
   * Not "this card can be renamed" — every owned card can, because the name is
   * ours to state and is kept in `core/names.ts` whatever the CLI does about
   * it. What this port decides is whether the statement also reaches the CLI,
   * so that its own header and its `/resume` list stay honest for whoever tabs
   * into a terminal mid-session.
   *
   * Absent is a brand with no door (Grok, 1.0.4) and costs the reader nothing
   * on the board; a divergence there is a recognition cost in a surface we do
   * not draw. Present is a courtesy call, made last and best-effort by
   * `host/sessions.ts`'s `stateName` — a brand whose echo never arrives (Codex,
   * measured 2026-09-05) is no different from one that has no door at all, and
   * neither is the reading a card follows.
   */
  readonly naming?: { rename(title: string): void };
  /** Answering an open ask or permission prompt. Absent for a brand whose
   *  permission RPC we have not read: no dialog, rather than a dialog whose
   *  answer goes nowhere. */
  readonly asks?: { respond(requestId: string, decision: Decision): boolean };
  /**
   * Ask this session's CLI what the account's plan usage is, now.
   *
   * The account's, not the session's — any session of the brand answers for all
   * of them, which is why the host asks whichever one it has rather than each.
   * Absent for a brand whose pipe cannot be asked; that brand's `UsageSource`
   * goes and looks somewhere else instead.
   *
   * **Answers mid-turn.** Measured 2026-09-02 against 2.1.241: the round trip
   * came back in 651ms while a 16s turn was running
   * (`reference/cli_state/claude/protocol.md`). So the host may ask while a
   * turn runs as well as after it ends; activity-driven reads do both.
   */
  readonly usage?: { read(signal?: AbortSignal): Promise<RateLimits | undefined> };
  /**
   * Write one cache-warming ping now, or refuse. Admission is checked here,
   * synchronously, against the brand's own drain latches, and the write goes
   * straight to the pipe — never through the outbox, so it is not merged,
   * published, drawn as an echo or taken as a first prompt.
   */
  readonly warm?: { ping(): WarmAttempt };
}

/**
 * Keep refusal text here because it is needed when the capability object is
 * absent. One copy makes the host re-check and panel gate agree.
 * Name no CLI: the reader sees a card whose mark already states the brand.
 */
const CANNOT: Readonly<Record<Capability, string>> = {
  messages: 'That session cannot be sent to from here.',
  turn: 'That session cannot have its turn ended from here.',
  model: 'That session cannot be moved onto another model.',
  // Every owned card can be renamed because names are ours (core/names.ts).
  // The refusal concerns a card this window cannot state a name for.
  naming: 'That session’s name is not one this window can state.',
  asks: 'That session cannot be answered from here.',
  warm: 'That session cannot keep its prompt cache warm.'
};

export function refusal(cap: Capability): string {
  return CANNOT[cap];
}

/** The launch line, composed by the brand that knows its flags. */
export type Launch = {
  bin: Program;
  args: readonly string[];
  /** Overlay on the host's own environment: a string sets, `undefined` deletes.
   *  Absent means the child inherits ours unchanged. */
  env?: Readonly<Record<string, string | undefined>>;
  /** End stdin and signal the child when the adapter has not established EOF
   *  as a sufficient shutdown. Absent keeps the existing EOF-only behavior. */
  terminateOnClose?: boolean;
  /** Files to prepare before starting the child, like the environment overlay. */
  files?: readonly { path: string; content: string }[];
};

/**
 * What a start decides, in the panel's words. Each brand maps these onto its
 * own flags, and omits what its CLI has no flag for rather than inventing one.
 */
export type LaunchOptions = {
  execution?: unknown;
  briefing?: string;
  /** The executable `resolveBinary` found. */
  bin: Program;
  cwd: string;
  /** The id to pin on a fresh start, so anything keyed by session id has
   *  somewhere to land before the CLI has named the session. */
  sessionId?: string;
  /** A conversation to carry on instead of beginning one. */
  resume?: string;
  model?: string;
  /**
   * The context window to start in, in tokens — the other half of what a start
   * names, and deliberately not folded into `model`.
   *
   * `model` is what `--model` takes verbatim; this is a fact about the session
   * that the CLI has no single spelling for. One window is reached by suffixing
   * the id, another by a flag on the launch line, a third by saying nothing —
   * so the adapter composes the line from the pair (`catalog.ts`'s
   * `CatalogWindow.reach`) and only it knows which is which.
   *
   * Absent means "say nothing", which is what every start did before this
   * existed: the account decides, and the card reads the window off the wire
   * rather than stating one.
   */
  window?: number;
  /** How hard the session thinks, when the reader has set one. */
  effort?: string;
  /** What the session is to be called, when it is started with a name. */
  name?: string;
  /** The reader has said this CLI may act without asking first. */
  skipPermissions?: boolean;
};

/** What the window holding the pipe knows before the child has said anything. */
export type OpeningContext = {
  readonly signal: AbortSignal;
  remaining(cap?: number): number;
  check(): void;
};

export type ConnectOptions = {
  opening?: OpeningContext;
  registerCleanup?: (cleanup: () => void) => void;
  failOpening?: () => void;
  execution?: ExecutionRuntime;
  briefing?: string;
  cwd: string;
  startedAt: number;
  sessionId?: string;
  /** A conversation to carry on. Separate from `sessionId`: a fresh Grok
   *  start already has a minted id, so "has an id" is not load (1.0.4). */
  resume?: string;
  /** What went on the launch line as the model, when the reader set one. */
  model?: string;
  /** What the launch/open request asked the session to reason at. */
  effort?: string;
  /** The window that launch line asked for, in tokens. The session holds it as
   *  `asked` until the wire states one — a start is the only moment anything
   *  knows this, since the CLI never reports what was requested. */
  window?: number;
  /**
   * How that window was *reached* on the launch line, when one was asked for.
   *
   * The line itself is the only witness, and it is gone by the time anything
   * asks. Two things need it and neither can re-derive it: the store guard
   * ("did this launch pin a window, or merely land in one"), and a model switch
   * ("is `CLAUDE_CODE_DISABLE_1M_CONTEXT` still on this session's line").
   * Recomputing from the *current* model is what goes stale — a session that
   * switches from a flagged model onto a plain one is still carrying the flag.
   */
  windowReach?: WindowReach;
  /** This session was started with a name somebody chose, so nothing may
   *  generate one over the top of it. */
  named?: boolean;
  /** The same skip the launch line took. Grok has no live mode string
   *  (2026-08-17); the card states this launch instead. Claude ignores it. */
  skipPermissions?: boolean;
  /** Somewhere to say what arrived on the pipe. What a brand puts here is its
   *  own business — it is a drift counter, not a protocol. */
  log?: (line: string) => void;
};

/**
 * Plan usage is a port because every poll reads every brand in one shape;
 * login is a one-time reader verb with a sheet. AccountSource is a port for
 * the same reason. core/usage.ts reduces and stores the answer without CLI knowledge.
 * Absent means the brand states no usage; a missing reading is read returning nothing.
 */
export type UsageSource = {
  /** The windows this CLI has, in paint order. `pct: null` is one the brand does
   *  not have, which is not the same as one we have no figure for. */
  readonly windows: readonly RateWindowDecl[];
  /** One reading, or nothing. Nothing covers every failure — an expired
   *  credential, a body that will not fold, no file to read — because none of
   *  them is news a card can act on. **Never touches the store**: what is kept
   *  and what is dropped is `core/usage.ts`'s, once, for all brands. */
  read(
    binaryOverride?: string,
    options?: import('./temporary_session').TemporaryRead
  ): Promise<RateLimits | undefined>;
  /** Interval, not duration: the shortest gap between two reads. */
  readonly everyMs: number;
  /**
   * `read` starts no process — a request from this host — so live activity
   * may spend it as well as the fallback. Absent: `read` may start a CLI
   * child, and only the fallback calls it.
   */
  readonly childless?: true;
  /**
   * How long a reading whose window states no reset time of its own is believed.
   *
   * The brand's, because the answer is its own shortest window — Claude's five
   * hours, so nothing outlives a window it could have been a reading of. A brand
   * with one window has a different answer and no 5-hour window to borrow.
   */
  readonly noResetMs: number;
};

/**
 * Account status is a port for UsageSource's reason: every pass reads every
 * brand in one shape; login and logout stay host verbs. core/signin.ts spends
 * status only when the stored answer is missing or stamp moved, without CLI knowledge.
 */
export type AccountSource = {
  /**
   * Ask the CLI. Nothing for every failure — a missing binary, a timeout, output
   * that will not parse — which is never a sign-out: that is `loggedIn: false`.
   */
  status(binaryOverride?: string): Promise<AccountRowStatus | undefined>;
  /**
   * A fingerprint of the local state `status` reads, taken without starting a
   * process. Equal stamps mean nothing a sign-in or sign-out writes has
   * changed. Never throws; a file that is not there is a stamp of its own.
   * Nothing means it cannot be told right now — a file caught mid-write with
   * no earlier reading to keep — which asks nothing and writes nothing.
   */
  stamp(): Promise<string | undefined>;
};

/** A window as its brand declares it, before any reading has filled it in. */
export type RateWindowDecl = { id: string; short: string; pct?: null };

/**
 * One CLI brand.
 *
 * Login is deliberately absent: it is not a `CliAdapter` port. The host
 * dispatches `startLogin` by brand (`host/panel_auth.ts` holds the rows). Whether
 * the CLI is signed in is a port, `account`, because it is read every pass.
 */
export type CliAdapter = {
  readonly execution?: ExecutionIntegration;
  readonly brand: BrandId;
  /**
   * The settings key holding a path the reader named for this CLI, when the
   * panel offers one. Named by the adapter so the host can read a setting for
   * whichever brand it is starting without knowing which brands exist.
   */
  readonly pathSetting?: string;
  /**
   * The vendor's own page saying how to install this CLI, which the accounts
   * row opens when `resolveBinary` finds nothing. A page and never an installer:
   * none of them are ours to run.
   */
  readonly installUrl: string;
  /**
   * The directory whose `skills/` this CLI loads user-scope skills from — where
   * the Squadron skill is installed for it.
   *
   * Each brand's own, even where another root would reach it. Probed
   * 2026-09-29 (Claude 2.1.284, Codex 0.158.0, Grok 1.0.41) with a throwaway
   * skill per candidate root: Claude reads `~/.claude/skills` alone; Codex
   * reads `~/.codex/skills` and `~/.agents/skills` and lists a name in both
   * **twice**; Grok reads `~/.grok`, `~/.agents` and `~/.claude`, one copy per
   * name, its own winning. So writing each brand's own root leaves every CLI
   * one copy, and writing `~/.agents` as well would hand Codex two.
   */
  skillRoot(home: string, env: NodeJS.ProcessEnv): string;
  skillSources(
    home: string,
    env: NodeJS.ProcessEnv,
    cwd?: string
  ): readonly import('./skills').SkillSource[];
  /**
   * Whether this CLI's login child opens a browser tab of its own.
   *
   * The host opens the tab for every brand that answers `false`, so this is
   * only ever a statement about the child, never a preference: opening a second
   * tab from the host races the IDE trust dialog and doubles the window.
   *
   * Two of the three are `false` because they open nothing — Codex answers with
   * a device code, and Claude is spawned under `BROWSER=true`, which silences
   * an open it would otherwise do. Grok is the one that still opens its own:
   * it goes through LaunchServices, where neither `$BROWSER` nor `PATH` can
   * suppress it even to try. Each witness sits at that brand's login spawn.
   *
   * **Absent means yes**, so a fourth brand costs a reader one click rather than
   * two windows.
   */
  readonly loginOpensBrowser?: boolean;

  resolveBinary(override?: string): Promise<BinaryFound | BinaryMissing>;
  /**
   * Why this brand cannot start, besides a missing binary. Absent means
   * nothing to check — Claude has no preflight.
   */
  preflight?(): Promise<{ ok: true } | { ok: false; reason: string }>;
  launch(options: LaunchOptions): Launch;
  connect(transport: SessionTransport, start: ConnectOptions): SessionHandle;
  /**
   * When somebody last sent this session something, epoch ms — the clock a
   * dated tally is `speaks`-ed against (`core/workflows/progress.ts`, `workflowDates`).
   *
   * **Not the resume activity read**, which is the newest entry of any
   * kind. A turn's own output is newer than the progress file the agent wrote
   * partway through it, so an activity clock silences the very tally the
   * feature exists to show.
   *
   * The session rather than a file, because a brand's prompts are not all in
   * one. Claude scans the `"type":"user"` jsonl it names; Grok and Codex read
   * **our** record instead, and both for the same reason — the CLI has nothing
   * a poll can afford. Grok stamps no time on a `chat_history.jsonl` row at
   * all, and its sibling `updates.jsonl` does but the newest
   * `user_message_chunk` sits a median 877 KB, and up to 5.6 MB, from the end
   * of the file (measured 2026-09-08 over the 40 largest here), so no tail
   * worth taking every poll reaches one. Codex publishes no transcript file at
   * all.
   *
   * **Ours is not free either**, and the port exists rather than every brand
   * reading the record because of what that costs. `readRecord` parses the
   * whole file — 944 of them here on 2026-09-08, median 44 KB, p90 151 KB, max
   * 531 KB — and caches on `size:mtimeMs`, so a *following* session that is
   * busy misses that cache on every poll where Claude's bounded tail did not.
   * The deeper reason is soundness: our record holds only what the pipe
   * witnessed and `appendLine` is allowed to fail quietly, by its own contract,
   * where a CLI's own file is authoritative for the whole conversation. So a
   * brand reads its CLI wherever that CLI can answer, and ours only where it
   * cannot.
   *
   * **Absent means this brand cannot say**, and a tally on it never retires by
   * prompt — which is what every brand but Claude did until this port existed.
   */
  lastPromptAt?(session: Session): Promise<number | undefined>;
  /** Every session of this brand running on the machine, from its own state on
   *  disk. One walk per brand — there is no shared one to add a case to.
   *  `table` is the process table to judge it against, for a caller that must
   *  know how complete that table was; otherwise the shared cached scan.
   *  `evidence` is that caller's one read of the published records, which
   *  the brand joins against instead of reading its own, and where it says
   *  what of its own files it could not decode or knows finished. */
  discover(pass?: HeadPass, table?: ProcessTable, evidence?: PassEvidence): Promise<Session[]>;
  /**
   * Where this conversation's file actually is, for a brand whose CLI can move
   * it out from under the path we hold.
   *
   * **Absent means trust `session.transcript`.** That is the answer for a CLI
   * that states its file once and leaves it there, and it is not a degrade:
   * Grok names `chat_history.jsonl` in its own directory, Codex pages by
   * durable thread id, and there is nothing about either a lookup could learn.
   * Claude files a transcript under a slug of the cwd the conversation *began*
   * in and relocates it on `EnterWorktree`, so its answer costs a `stat` and
   * sometimes a sweep — see `claude/transcript.ts`.
   *
   * `pinned` is a candidate the caller already holds, never this port's own
   * previous answer. `home` is the directory the file says the session lives
   * in, for a caller with no `init` frame to have watched (`claude/discover.ts`);
   * a live half carries `LiveState.originCwd` and drops it.
   */
  locateTranscript?(
    cwd: string,
    sessionId: string,
    pinned?: string
  ): Promise<{ file: string; home: string }>;
  /** Read this session through the brand's own transcript reference. A file is
   *  only one brand's reference; Codex pages by durable thread id. */
  readTranscript(session: Session, binaryOverride?: string): Promise<Recent>;
  /**
   * The same thread, plus every message id the read saw — what
   * `readSessionTranscript` weighs our own record against.
   *
   * Both out of one call, so the file is parsed once per poll: `readTranscript`
   * beside it would be a second parse, a second failed `stat` counted against
   * the fallback reader's hold, and a window in which the file can move between
   * the two answers.
   *
   * **Absent means this brand cannot say**, and a brand that cannot say never
   * draws from our record — there is no way to tell a whole one from a holed
   * one, and drawing a holed one is the single failure this comparison exists
   * to prevent. No brand is that case today; the next one to arrive is, until
   * it finds a key both halves of its CLI write down for the same turn.
   */
  readWitnessed?(
    session: Session,
    binaryOverride?: string
  ): Promise<{ recent: Recent; witnessed: ReadonlySet<string> }>;
  /**
   * The bytes behind an image ref this CLI's own transcript is holding, as a
   * data URL, for a reader who clicked a chip.
   *
   * **`f|` and `r|` never reach here; `p|` reaches here only once its file is
   * gone.** All three are `core/record.ts`'s — `refFile` and `attachmentFile` —
   * and all three are read off disk first. The two that are excluded outright
   * are the ones a CLI's transcript could not be holding anyway: a file a turn
   * merely pointed at, and one of our own store's. A `p|` is different, and the
   * difference is why the exclusion is not simply "names a file": the CLI
   * re-encodes as it reads, so its transcript holds bytes for a path that has
   * since been swept.
   *
   * **Absent means this brand has no such address**, and a chip whose ref
   * misses on disk says the image is gone rather than tailing a file to find
   * out. Claude is the only brand with one measured — `t|<uuid>|<block>`, the
   * one address no module of ours mints, plus that `p|` fallback. Grok and Codex leave it
   * absent on purpose rather than by omission: neither CLI's spelling of an
   * embedded image has been observed, disk-first already answers every ref the
   * panel has seen either brand carry, and a guessed scheme would read as a
   * missing picture rather than as a wrong one.
   *
   * The file rather than the session, because that is the whole of what a brand
   * with this address needs — `session.transcript`, after `relocate` has had
   * its say.
   */
  readImage?(file: string, id: string): Promise<string | undefined>;
  /**
   * The maintained catalog or last successful account catalog, synchronously.
   * Account refresh is separate: `refreshModels`.
   */
  models(): readonly Model[];
  /** Whether the offered IDs are maintained by us or reported by an account. */
  readonly modelSource: 'maintained' | 'account';
  /**
   * Re-read an `'account'` catalog, answering whether one is now held.
   * `core/signin.ts` decides when — once per stamp of `account`.
   */
  refreshModels?(binaryOverride?: string): Promise<boolean>;
  /**
   * One of this CLI's permission modes as the strip reads it, or nothing when
   * it is the mode most sessions are in — a word on every card saying "normal"
   * is a row of the board spent on the absence of news.
   *
   * The brand's own, because the vocabulary is. `ui/views.ts` held all three
   * brands' words in one table until Codex arrived with a mode that is not a
   * single word at all.
   */
  permissionView(mode: string): PermissionView | undefined;
  /** The account's plan usage, when this CLI states one. */
  readonly usage?: UsageSource;
  /** Whether this CLI is signed in, and the local state that answer reads. */
  readonly account?: AccountSource;
};

/**
 * A record rather than register calls makes the brand list independent of
 * import order (reference/learnings/agent_flow.md §2). One registry line plus
 * one directory adds a brand.
 */
const ADAPTERS: { readonly [B in BrandId]: CliAdapter & { readonly brand: B } } = {
  claude: claudeAdapter,
  grok: grokAdapter,
  codex: codexAdapter
};

/**
 * Keep both fallbacks here, not in ui/views.ts: absent brand means Claude,
 * while an unknown adapter states the mode rather than dropping it. A card
 * may come from a window that knows a brand this build does not. The strip
 * should decide neither fallback.
 */
export function permissionViewOf(
  brand: string | undefined,
  mode: string
): PermissionView | undefined {
  const cli = adapter(sessionBrand(brand));
  return cli ? cli.permissionView(mode) : asStated(mode);
}

/**
 * Check the roster before indexing: prototype names are not adapters.
 * Do not default here: callers with no brand choose Claude; unknown brands
 * are refused. Combining those cases silently starts the wrong CLI.
 */
export function adapter(brand: string): CliAdapter | undefined {
  return isBrand(brand) ? ADAPTERS[brand] : undefined;
}

export const CANNOT_START_CLI = 'That CLI cannot be started from here.';

/**
 * Absent is the caller's default. A named brand this build has no adapter
 * for is refused: folding it onto Claude starts the wrong CLI.
 */
export function brandForStart(
  named: unknown
): { ok: true; brand?: BrandId } | { ok: false; reason: string } {
  if (named === undefined || named === null) return { ok: true };
  const known = typeof named === 'string' ? adapter(named) : undefined;
  if (!known) return { ok: false, reason: CANNOT_START_CLI };
  return { ok: true, brand: known.brand };
}

/**
 * An absent brand means Claude, as model.ts states and pre-brand sessions
 * require. Keep readSessionTranscript's additional fallback there, rather
 * than hiding a difference between callers.
 */
export function adapterFor(session: Pick<Session, 'brand'>): CliAdapter | undefined {
  return adapter(sessionBrand(session.brand));
}

/**
 * Only the dock's running-session list stamps unreachable windows fixed:
 * A start composes its own launch line, and the gear's list is not built here;
 * that is what keeps its flyout clean.
 * from is Session.launchReach for that field's reason; wide is defaultsWide
 * for the running model so a narrow-plan reader can pick a window that works.
 * Either undefined stamps less; both stamp nothing.
 * Copy marked rows because offeredModels returns module-level catalog rows
 * and readonly is erased at runtime.
 */
export function modelsForSession(
  brand: BrandId | undefined,
  models: readonly Model[],
  from?: WindowReach,
  wide?: boolean
): Model[] {
  const want = sessionBrand(brand);
  const offered = models.filter((model) => model.brand === want);
  // A running conversation remains readable after its account stops being
  // startable; the adapter catalog still owns its model and effort vocabulary.
  // `unlisted` is dropped here too: this is a *pick* list, and the fallback
  // reads the catalog raw rather than the list `offeredModels` already sifted.
  const rows = offered.length
    ? offered
    : (adapter(want)
        ?.models()
        .filter((model) => !model.unlisted) ?? []);
  return rows.map((model) =>
    reachableFrom(model.brand, model.value, model.window, from, wide)
      ? model
      : { ...model, fixed: true as const }
  );
}

/**
 * Keep availability outside the adapter because installation and sign-in
 * are this machine's changing answers, read on each poll.
 */
export type BrandAvailability = {
  brand: BrandId;
  /** `false` = looked, found nothing. `undefined` = not looked yet. */
  installed?: boolean;
  /** `false` = asked, no account. `undefined` = not asked yet. */
  signedIn?: boolean;
};

/**
 * Drop known missing binaries or accounts, never unknowns: filtering unknown
 * would empty the flyout on the first paint of every window. The synchronous
 * catalog removed that bug; it must not come back through the filter.
 * Keep this rule headless because host/ imports vscode
 * and cannot be unit-tested; the host states only availability.
 */
export function offeredModels(brands: readonly BrandAvailability[]): Model[] {
  return brands.flatMap((available) => {
    const cli = adapter(available.brand);
    if (!cli || available.installed === false || available.signedIn === false) return [];
    // Spread rows because models() returns the module-level catalog and readonly
    // is erased; a write would corrupt every later poll (adapter.test.ts).
    // Filter unlisted here so flyout, gear and wire agree on what may be offered;
    // catalogFor retains those rows to recognise sessions already running them.
    return cli
      .models()
      .filter((model) => !model.unlisted)
      .map((model) => ({ ...model, brandLabel: brandName(cli.brand) }));
  });
}

/**
 * One session's thread, and which of the two records it came out of — for a
 * session no window holds a pipe to. One this window drives is drawn from
 * memory instead (`ownedTranscript`).
 *
 * **Our own when it covers everything the CLI's file could show, and the CLI's
 * file otherwise** — roadmap row 54's Phase 2, and the rule is `record.ts`'s
 * `drawableFor`. Never a stitch: one source per read, so no join key exists to
 * duplicate or drop a turn.
 *
 * `ours` is not decoration. The dock says which it is reading, because the
 * fallback is a parse of a format nobody contracted and can be imperfect in ways
 * the reader can see but cannot explain.
 *
 * Both are read every time and both are cached on their own file's
 * `size:mtimeMs`, so the reading handed back is the *same object* while neither
 * file has moved — which is what lets `renderTranscript` skip its whole view
 * rebuild on a poll that changed nothing.
 */
export type Sourced = { recent: Recent; ours: boolean };

/**
 * Neither reader branch may throw: a rejected buildThread stops refreshOnce's
 * Promise.all from pushing the board, and closeSession would never reach endHeld.
 * Brands handle expected emptiness (codex/transcript.ts unmaterialized); this
 * is the generic backstop so CLI changes shrink cards rather than break the panel.
 * There is no diagnostic sink here.
 * An unknown adapter reads empty: falling through to Claude would parse another
 * CLI's file with the wrong parser.
 */
export async function readSessionTranscript(
  session: Session,
  binaryOverride?: string
): Promise<Sourced> {
  const cli = adapterFor(session);
  if (!cli) {
    return { recent: { exchanges: [], truncated: false }, ours: false };
  }
  const witnessing = cli.readWitnessed?.bind(cli);
  if (!witnessing || !session.sessionId) {
    const recent = await cli
      .readTranscript(session, binaryOverride)
      .catch(() => ({ exchanges: [], truncated: false }));
    return { recent, ours: false };
  }
  const theirs = await witnessing(session, binaryOverride).catch(() => ({
    recent: { exchanges: [], truncated: false },
    witnessed: NO_WITNESS
  }));
  const mine = await readRecord(session.sessionId);
  const drawn = drawableFor(session.sessionId, mine, theirs.witnessed, theirs.recent.truncated);
  if (!drawn) {
    return { recent: theirs.recent, ours: false };
  }
  return {
    recent: await transcriptAttribution.claimed(
      conversationKey(cli.brand, session.sessionId),
      session.sessionId,
      drawn,
      mine
    ),
    ours: true
  };
}

/** Attributes a captured thread's completed history; the caller renders its tail. */
export async function ownedTranscript(
  brand: BrandId | undefined,
  shot: ThreadSnapshot
): Promise<Sourced> {
  const ours = !shot.reconstructed;
  const cli = adapter(sessionBrand(brand));
  if (!cli || !shot.conversation) {
    return { recent: shot.recent, ours };
  }
  return {
    recent: await transcriptAttribution.claimed(
      conversationKey(cli.brand, shot.conversation),
      shot.conversation,
      shot.recent,
      shot.history
    ),
    ours
  };
}

/**
 * Which conversation of which owned session: the handle object — a restart or
 * a resume is another — and its thread's generation, which a `/clear` moves.
 */
export type OwnedStamp = { readonly handle: Owned; readonly generation: number };

/** What a reading needs of a handle. */
type Owned = Pick<SessionHandle, 'state' | 'thread'>;

export function ownedStamp(handle: Owned | undefined): OwnedStamp | undefined {
  return handle && { handle, generation: handle.thread.generation() };
}

/** A refresh's captured state and its order among this window's readings. */
export type OwnedCapture = OwnedStamp & {
  readonly historyState?: 'loading' | 'failed';
  readonly live: LiveState;
  readonly shot: ThreadSnapshot;
  readonly order: number;
};

let captures = 0;

/**
 * Capture immutable card state and thread together before any await, so a
 * message crossing from outbox to thread appears exactly once. Attribution
 * and rendering use these values even if frames arrive during their awaits.
 */
export function captureOwned(handle: Owned): OwnedCapture {
  const shot = handle.thread.snapshot();
  return {
    handle,
    generation: shot.generation,
    live: handle.state,
    shot,
    historyState: handle.thread.historyState,
    order: ++captures
  };
}

/**
 * Whether a refresh may publish what it composed from `capture`, asked after
 * its last await. Not when the poll's card was of another conversation than
 * the capture (`polled`) — card, workflow and thread would describe two; nor
 * when the session has been replaced or cleared since (`now`); nor when a
 * refresh that read later has already published (`published`, its `order`).
 * A refused one is never the last: the change that made it obsolete has
 * asked for the refresh after it.
 */
export function publishable(
  capture: OwnedCapture,
  polled: OwnedStamp | undefined,
  now: OwnedStamp | undefined,
  published: number
): boolean {
  return capture.order > published && sameOwned(polled, capture) && sameOwned(now, capture);
}

function sameOwned(a: OwnedStamp | undefined, b: OwnedStamp): boolean {
  return a?.handle === b.handle && a.generation === b.generation;
}

/**
 * Whether a session has said anything — End's question, before it decides
 * between confirming and stopping outright.
 *
 * A session this window drives is asked of its memory, **after its recovery
 * has landed**: a resumed card ended while its history is still being read
 * holds none of it yet, and an empty answer there would end a conversation
 * with history without asking. `recovered` never rejects and gives up within
 * seconds (`recoverBaseline`); a recovery that gave up recovered nothing, so
 * memory's silence there is no answer, and the files are asked as they are
 * for any other session — background, the one card here no window holds.
 */
export async function hasExchanges(
  session: Session,
  held: SessionHandle | undefined,
  binaryOverride?: string
): Promise<boolean> {
  if (held) {
    const landed = await held.thread.recovered;
    const { recent, tail } = held.thread.snapshot();
    if (recent.exchanges.length > 0 || recent.truncated || tail.length > 0) return true;
    if (landed) return false;
  }
  return (await readSessionTranscript(session, binaryOverride)).recent.exchanges.length > 0;
}

/**
 * Decide ThreadView.fallback here so the dock does not pick the source again.
 * Not simply !ours: drawable declines empty records, and an empty conversation
 * has no reconstruction to disclose. A truncated read does: those turns went unread.
 */
export function reconstructed({ recent, ours }: Sourced): true | undefined {
  return !ours && (recent.exchanges.length > 0 || recent.truncated) ? true : undefined;
}

/** Every brand's walk, concatenated. The panel and the stop CLI share this
 *  so a brand added to the registry is found in both without a second list. */
export async function discoverAll(
  pass?: HeadPass,
  table?: ProcessTable,
  evidence?: PassEvidence
): Promise<Session[]> {
  const found = await Promise.all(
    BRANDS.map((id) => {
      const cli = adapter(id);
      return cli ? cli.discover(pass, table, evidence) : Promise.resolve([]);
    })
  );
  return found.flat();
}
