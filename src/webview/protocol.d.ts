/**
 * The panel's wire format, declared once for both halves of it.
 *
 * Ambient rather than imported: the webview half compiles to a bare script and
 * cannot carry a `require`. Because both sides check against these, a field
 * renamed in `panel.ts` fails the build instead of quietly rendering nothing.
 */

type SessionStatusView = 'busy' | 'idle' | 'waiting' | 'unknown';

/**
 * The panel's own colours. `follow` is the absence of a preset: every token
 * resolves to the host theme's, which is what the panel has always looked like.
 */
type ThemeName =
  | 'follow'
  | 'ink'
  | 'lift'
  | 'paper'
  | 'neon'
  | 'polaroid'
  | 'mario'
  | 'nightcity'
  | 'arasaka'
  | 'malachite';

/**
 * Which count a card is under, and the hue it wears — one value for both,
 * because a card in one bucket painted in another's colour is the drift this
 * closes. `done`, `stalled` and `failed` are readings of `idle`, not states.
 */
type Tally = SessionStatusView | 'done' | 'stalled' | 'failed';

/** What a card says it is: the pill's word, and its count and hue. */
interface CardReading {
  word: string;
  tally: Tally;
}

/** One session, as a card. */
interface CardView {
  pid: number;
  name: string;
  fullCwd: string;
  /**
   * `@squadron[<pid>][<transcript>]`, the text the card's Copy reference puts on
   * the clipboard. The `@` menu's session pick sends it. Absent with no
   * transcript yet, which `findRefs` could not find again.
   */
  ref?: string;
  status: SessionStatusView;
  /** A maintenance ping is in flight; independent of the warming preference. */
  warming?: true;
  /** Busy on our write, before the CLI opened the turn: no interrupt to offer. */
  turnPending?: true;
  /** A command of the session's own is running, whatever else it is doing. */
  hasCommand?: boolean;
  waitingFor?: string;
  /**
   * How far through its own step list the session is, idle only
   * (`ui/reading.ts` `stepList`). The count `squadron-list` prints; the card's
   * own word for it is already in `reading`.
   */
  completion?: { total: number; completed: number };
  /**
   * What the card says, resolved on the host by `ui/reading.ts` `resolve`,
   * which owns which facets may speak and how they rank. The webview paints it
   * and never re-derives it.
   */
  reading: CardReading;
  /** The session replied after its last deliberate acknowledgement. */
  unread?: CardReading;
  /** Waiting, stalled or failed, until deliberately acknowledged. */
  attention?: true;
  /**
   * An end has been sent to this session and its process is still there.
   *
   * The window that sent it says so, and only it: nothing replies to an end,
   * so the card is drawn until the process is seen to go — an owned one off
   * the state it had when its pipe closed, which stops being true at that
   * moment. The card says what is happening to it instead of that state word.
   *
   * `status` is untouched, like `reading` and `completion`: this is a reading of
   * what was done to the session, not a fifth state word.
   */
  closing?: true;
  /** An explicit End attempt failed; native cleanup may still finish later. */
  endStuck?: true;
  /** Explanation of an explicitly unsuccessful native shutdown attempt. */
  endFailure?: string;
  /**
   * The session accepts the controls that end things — interrupt on the turn,
   * stop on the session.
   *
   * The host projects normalized kind facts, keeping local close/dismiss
   * controls independent of routing metadata and caller authority. `endable`
   * in `webview/chat.ts` asks whether there is a turn to end right now.
   *
   * Required, unlike `closing` and `owned` beside it, because absence would be a
   * lie with a verb behind it: a card that forgot to state this would silently
   * lose its stop button rather than draw an extra one. Copy-reference is
   * deliberately outside it (`board_card.ts`).
   */
  canControl: boolean;
  /**
   * This window drives the session over its pipe.
   *
   * **Since row 71 this is true of every card but one**, and the one is a
   * background session — run by the CLI's own agents feature under its daemon,
   * so no window holds a pipe to it at all. A session another window started is
   * not on this board to ask about. It used to be, and the note here used to
   * say the flag took away the local shortcut and never the verb; there is no
   * such card now, so what the flag fences is background.
   *
   * Kept as its own field rather than folded into `canControl` because the two
   * are different questions that happen to agree today
   * (`TASK_done_state_derivation_seam.md` is about exactly that drift). A
   * session someone typed `claude` for is not known to the panel at all, so
   * nothing here asks whether a card is one.
   */
  owned?: boolean;
  needs?: string;
  model?: string;
  /**
   * The alias the panel put this session on — `LiveState.modelPick`, which
   * states what it is. Owned sessions only.
   *
   * A card prints the reading, then this pick, then the brand — never a
   * hardcoded CLI name. A control resolves the pair
   * (`core/model_names.ts:resolveModel`), which is what lets a row be ticked
   * before the session has run a turn. A target held in the composer is not
   * this field and stays off the card.
   */
  modelPick?: string;
  /** Whose CLI this is, for the mark the card draws beside the model. Stated by
   *  the seam that knows and never inferred here: `model` is opaque (see
   *  `ModelView`), and root `AGENTS.md` keeps brand checks out of `webview/`. */
  brand?: BrandId;
  effort?: string;
  contextPct?: number;
  contextSize?: number;
  /** The window this session last asked for — its launch line, or a switch
   *  since. As `Session.contextAsked` (`core/model.ts`), which states the whole
   *  of it. */
  contextAsked?: number;
  /** Context spent as a token count, when nothing stated the window it is a
   *  share of. A card shows one or the other, never both. */
  contextTokens?: number;
  startedAt: number;
  /** Last real activity, falling back to startedAt when no activity was stated. */
  updatedAt: number;
  /** The cache's stamp and deadline; absent during ordinary busy work or
   *  before any turn has cached. */
  cacheFrom?: number;
  cacheUntil?: number;
  /** The cache lifetime this session is timed against, stamp or none. */
  cacheTtlMs: number;
  /** Whether this session is kept warm, decided on the host by `warmDue`
   *  (`core/warm.ts`); see `WarmView`. Absent only where no clock was
   *  projected — the thread's copy of a card, and `squadron-list`. */
  warm?: WarmView;
  /** The checkout the session runs in, read from `.git` itself. All three are
   *  absent outside a repo, and absent again once that checkout goes away —
   *  a card names where its session is, and says nothing when it cannot tell.
   *  `branch` is a short sha rather than a name when `detached`. */
  branch?: string;
  detached?: boolean;
  /** A linked worktree — the one the `branch` beside it was read from, which
   *  for a session that has moved is not the checkout its card groups under
   *  (`core/model.ts`, `liveWorktree`). */
  worktree?: boolean;
  /** Where the process actually stands, when that is not the folder the card
   *  groups under — a group keys on where a session was *started*
   *  (`core/live.ts`, `originCwd ?? cwd`). **Read and never painted**: the
   *  composer's clip opens its dialog here, so a session that has moved offers
   *  the directory it is in rather than the one it came from. */
  liveCwd?: string;
  /** What the footer strip says about the session's permission mode, or nothing
   *  — `default` and an unread mode both print nothing. Composed by `modeView`,
   *  so the card only paints it: `holds` picks the glyph, `bypass` the colour. */
  mode?: { label: string; holds: boolean; bypass: boolean };
  /** Who spawned this session, and what it spawned — both pids of sessions that
   *  are **live**, so both resolve against a card in `state.groups`. That is the
   *  whole contract: there is no stamped name here to go stale, because a name
   *  is read off the card the pid finds.
   *
   *  Absence means "no record, **or** a parent that is not running" — a session
   *  started by hand, one whose spawn predates the record, one whose parent has
   *  closed or `/clear`ed, and one whose record has been swept are all the same
   *  absence, and the panel cannot tell them apart. It is never "root": nothing
   *  here may be rendered as a claim about being the top of a tree. */
  parent?: number;
  children?: number[];
}

/** One thing the thread shows: a turn somebody produced, or a mark left by
 *  something that happened to the conversation rather than in it. */
type ExchangeView = AuthoredView | MarkerView;

interface AuthoredView {
  maintenance?: boolean;
  /** The admitted ping input owning this row, independent of arrival order. */
  warmId?: string;
  warmEvidence?: import('../core/model').WarmTurn;
  /**
   * `cli` is a turn the CLI wrote where the model's would be — an API error, a
   * usage limit. It authored it, so it is named as the author.
   *
   * `wait` is a registered wait converging, and it is the one role no session
   * composed: the extension host wrote it. It never carries a `from`;
   * `core/coordination/send.ts`'s `WAIT_OPEN` says why.
   *
   * `warm` is a cache-warming ping, drawn as one maintenance row; the model's
   * reply to it is not drawn.
   */
  role: 'user' | 'assistant' | 'cli' | 'wait' | 'warm';
  /**
   * A `cli` turn that is a slash command's own output, rather than the CLI
   * speaking where the model failed to.
   *
   * The role stays `cli` because the author is the same one — a flag rather
   * than a fourth role, which every switch over the three would have to be
   * taught. What it changes is only the drawing: the rest of `cli` is an alarm
   * (an API error, a usage limit, a session resumed elsewhere) and wears the
   * red rule for it, while this is a readout the reader asked for and would be
   * misread in that colour.
   */
  local?: true;
  /** Prose is still arriving for this exchange. */
  streaming?: true;
  /** The reply ended before it completed; keep the received prose. */
  cut?: true;
  text: string;
  /** Files the turn wrote, in the order it wrote them, deduped. **Absolute** —
   *  a `file_path` may be written relative to the session's directory, and
   *  `core/` resolves it there so nothing downstream needs the cwd to open one. */
  files?: string[];
  /** How much of each of those files the turn wrote, keyed by the same absolute
   *  path. What a path with no entry here means, and what it draws, is on
   *  `counts` in `chat.ts`. */
  sizes?: Record<string, Written>;
  /** A path this turn changed is **missing** from `files`, because another
   *  session was writing in the same folder and touched it too. Why it is an
   *  omission rather than a badge: `Attributed.concurrent`
   *  (`core/checkpoint.ts`). */
  concurrent?: true;
  /** The turn's baseline tree hash, for the diff a pill opens. Absent where
   *  the turn has no checkpoint. */
  base?: string;
  /**
   * What the turn is made of, in the order it wrote it — the prose and the
   * calls interleaved, so a turn that spoke, ran something and spoke again
   * reads as three things. Empty for a turn that is only an image.
   *
   * Not one `html` string with a list of tool names under it, which is what
   * this replaced: the interleaving is in the transcript, and one blob of
   * markup cannot hold a row between two paragraphs. `text` beside it is still
   * the same prose joined, and still what an echo is matched against.
   */
  blocks: BlockView[];
  /** When the CLI wrote this turn down, epoch ms. Absent when it stamped none.
   *  What a fold measures a turn's length between — and the CLI's own stamp is
   *  when the *model* wrote the block, not when the line reached disk, so it
   *  measures the work rather than the wait for the writer. */
  at?: number;
  /** Images the turn carried, in the order it carried them. Absent for almost
   *  every turn. The bytes are not here — see `ImageRef`. */
  images?: ImageRef[];
  /** The skill this turn ran under. The dock shows it where it changes, so a
   *  long run under one skill is tagged at its start, not on every turn. */
  skill?: string;
  /**
   * The session that sent this turn, for a message another session addressed to
   * this one. A `user` turn either way — somebody authored it — and marked as
   * theirs rather than drawn as the reader's own, which is also why the
   * prompt-nav steps over it: it is not something the reader asked for.
   */
  from?: string;
}

/**
 * One piece of a turn: a run of prose, or one call the turn made.
 *
 * A call arrives already in the reader's words (`ui/activity.ts`) and already
 * cut to size (`core/transcript.ts`) — the webview neither summarises nor
 * truncates, so nothing here has to be trusted to do it twice the same way.
 * All three strings are plain text and are set as `textContent`: only `html`
 * goes through the sanitizer, because only `html` is markup.
 *
 * `summarized` is prose the CLI's server rewrote rather than the model's words —
 * `Block`'s flag, carried so the dock can say so.
 *
 * `prose` is a `user` turn's source text, whoever wrote it: the composer, a
 * peer, a spawn prompt, a wait's wake-up. The webview parses it as it parses
 * the echo, so a sent message keeps its look when the transcript replaces the
 * echo. Any other turn is `html` from the host's engine, a different parser.
 */
type BlockView = { html: string; summarized?: true } | { prose: string } | ToolView;

/** One tool call, as a row. */
interface ToolView {
  /** What it did: "Ran command", "Read file", or the tool's own name. */
  summary: string;
  /** The one thing it did it to, shortened for the column. */
  detail?: string;
  /** The unshortened form, for a tooltip, when it says more than `detail`. */
  title?: string;
  /** What it returned, cut at ingest to 180 characters and marked with an
   *  ellipsis when it was cut. Absent for a call still running. */
  output?: string;
  /** The result said it failed. */
  failed?: boolean;
  /** An `AskUserQuestion`'s record, for a reader who wants to see what they were
   *  asked. Absent on every other tool. */
  ask?: AnsweredAskView;
}

/**
 * A question somebody already answered, as the dock replays it.
 *
 * Four arrays indexed alike, one slot per question — the same indexing a live
 * dialog's `staged` picks use, so one paint draws either. Resolved host-side by
 * `core/answers.ts`: the CLI writes labels, and matching a label against an
 * option list is exactly the knowledge the webview should never hold.
 *
 * A record is not a request. There is no `requestId` here because nothing can
 * be answered — the session moved on long ago, and every control a replay draws
 * is read-only.
 */
interface AnsweredAskView {
  questions: PendingQuestion[];
  /** Which options were picked, per question. Empty for one answered in the
   *  reader's own words, and for one nobody answered at all. */
  picks: number[][];
  /** What was typed instead of picking — the `Other` row's words. Empty string
   *  where there were none, so the array stays dense. */
  texts: string[];
  /** What was said beside the pick. Dense like `texts`. */
  notes: string[];
}

/** No author, no words: the dock owns what a skill chip and an interrupt say.
 *  Carrying no `text` is what keeps it out of everything that reads a turn's
 *  prose — the composer's echo match, the markdown engine, the turn key. */
interface MarkerView {
  mark: 'skill' | 'break' | 'trigger';
  /** The skill's name. `skill` only. */
  skill?: string;
  /** Who reached for it. A skill the reader typed as `/name` is shown in their
   *  own voice: the CLI turns a slash command into scaffolding and an expanded
   *  body, neither of which is a turn, so this chip is the only record that
   *  they asked at all. `skill` only. */
  by?: 'you' | 'agent';
  /** What started the turn below it — `core/transcript.ts`'s `Marker`.
   *  `trigger` only. */
  trigger?: 'task' | 'agent';
  /** How that ended, in the CLI's word; absent when it said none. `trigger`
   *  only. */
  status?: 'completed' | 'failed' | 'stopped';
  /** Epoch ms. A fold below it times from here. `trigger` only. */
  at?: number;
}

/**
 * An image on a turn, named but not carried: a real paste is most of a megabyte
 * of base64, and the dock repaints every 3s, so the thread ships
 * the name and the webview asks for the bytes when a reader opens one.
 *
 * `id` is opaque here and parsed only by the host, which is what lets the two
 * ways an image reaches a prompt — a path in the text, or a block inside the
 * turn — differ without the protocol knowing.
 */
interface ImageRef {
  id: string;
  /** Only the CLI's own `[Image: original WxH…]` note records these, so a turn
   *  that was pasted into the TUI has no dimensions to show. */
  w?: number;
  h?: number;
  /**
   * Stated media type and decoded byte length of a paste we copied (`r|`).
   * Absent on a path we only point at (`f|`, `p|`) — those resolve off disk.
   */
  mediaType?: string;
  sizeBytes?: number;
}

/** One question of a pending AskUserQuestion, its options read off the pipe. */
interface PendingQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  /** Absent means offered. `false` hides the own-words row when the CLI's
   *  response accepts only one of its stated options. */
  canOther?: boolean;
  options: QuestionOption[];
}

/** One choice of a PendingQuestion: its button label, plus the explanatory line the CLI showed under it. */
interface QuestionOption {
  label: string;
  description?: string;
  /** Whitespace-significant sample the ask offered for this choice, e.g. a mockup. */
  preview?: string;
}

/**
 * One request an owned session is blocked on, waiting for a person.
 *
 * `ask` is a question; `permission` is a tool allow. Which RPC produced either
 * is the adapter's. Answered by `requestId` — a decision for an id that is gone
 * is dropped rather than applied to the next one.
 */
type PendingRequestView = { requestId: string } & (
  | {
      kind: 'ask';
      questions: PendingQuestion[];
      /**
       * Whether this dialog offers Add a note / Reply instead. Absent means
       * offered (Claude). `false` hides that control — a brand that cannot
       * send the arm, not a brand check in the renderer.
       */
      canNote?: boolean;
      canReply?: boolean;
    }
  | {
      kind: 'permission';
      toolName: string;
      /** The CLI's own short description of the call — `notes.txt`, `Write hi to
       *  out.txt`. Never composed here: the CLI knows what the call is about. */
      label: string;
      /** The tool's input, formatted for reading. Rendered as text, never as
       *  markup — it is a model's output about to be shown to a person. */
      input: string;
      /** Absent means offered. `false` makes Deny an immediate decision for a
       *  wire whose refusal cannot carry the optional reason. */
      canDenyReason?: boolean;
      /**
       * What an always-allow would write, in the words of where it writes it —
       * `this session only`, `.claude/settings.local.json, in this project`,
       * and so on, as each brand's decoder named it. Absent when any suggestion
       * went unnamed, or there was none, and then no such button is offered: a
       * control that cannot say what it persists is worse than no control.
       */
      always?: string;
    }
);

/** What a reader decided about one pending request: an ask's picks, or a
 *  permission allowed once, allowed always, or denied. */
type RequestDecision =
  | {
      allow: true;
      /** An ask's picks, `picks[i]` indexing `questions[i].options`. Absent for
       *  a permission prompt, which has nothing to choose. */
      picks?: number[][];
      /**
       * What was typed per question, indexed like `picks` — the panel's own
       * `Other`, which the CLI's widget offers as a row and the option list
       * cannot. What it means when a question has a pick, and when it has none,
       * is stated once in `answerPayload` (`core/answers.ts`), which is the code
       * that reads it.
       *
       * Only ever set for an owned session, which is the only kind whose ask
       * the panel answers at all.
       */
      texts?: string[];
      /**
       * What was said *about* question `i`'s pick, indexed like `picks` — a
       * remark on the answer rather than the answer itself, which is what makes
       * it a second field and not more of `texts`.
       *
       * Rides to the CLI as `annotations`; the rule for it is stated once in
       * `annotationPayload` (`core/answers.ts`). Only ever set where a real
       * option is picked: a question answered in the reader's own words has
       * nothing to annotate.
       */
      notes?: string[];
      /** Allow this again without asking, by handing the CLI back its own
       *  suggestion. Ignored when the request carried none. */
      always?: boolean;
    }
  /**
   * A refusal, and the words that go with it. `message` is what the model is
   * told instead of the tool's result: the ask's "Reply instead" — the CLI's own
   * `Chat about this`, which is a denial carrying feedback rather than a cancel
   * — and the permission dialog's reason box both set it. Absent still denies,
   * and the host writes its own neutral line then.
   */
  | { allow: false; message?: string };

/** One held outbox row as the dock draws it. */
interface QueuedView {
  id: string;
  /** The words, never the envelope: the outbox holds what the wire took, and
   *  `ui/views.ts` reads it back through `core/coordination/send.ts`'s `delivered`. */
  text: string;
  /** How many images ride with it. A paste with no prose is a legal send, and
   *  without this the row draws empty and cannot be told from its neighbour. */
  images?: number;
  /** Absent for the reader's own words, which is what an outbox row usually
   *  is. `wait` is a registered wait converging — the one author no session
   *  composed, and it carries no `from`, for `AuthoredView.role`'s reason. */
  role?: 'wait';
  /** The session that sent it, for a peer's message. The dock draws the same
   *  label and id crumb it draws on the turn once the transcript holds it. */
  from?: string;
}

type EchoEvidence = { text: string } | { skill: string };

interface ThreadView extends CardView {
  /** User/skill candidates from the existing history window, independent of display. */
  echoEvidence?: EchoEvidence[];
  /** Resume history acquisition; absence means settled successfully or a fresh session. */
  historyState?: 'loading' | 'failed';
  /**
   * Provenance: this session was asked to follow a workflow. Present whenever
   * the session has a readable progress file — which exists only for an arming
   * message that was actually taken, since the host undoes its own seed on
   * every refusal. Absent when there is none, when the file was unlinked by a
   * dismiss or a resume, or when the session is not one the panel owns.
   * Composer shelf + optional observe drawer — never on `CardView` / board.
   *
   * Note it does **not** go absent when the pipeline finishes or the child
   * exits: a card whose session has ended keeps showing what its workflow
   * reached, which is when a reader is most likely to look.
   *
   * `label` is the workflow name (coarse “Following X”). `phase` is the
   * run-level rollup (`running` | `done` | `failed`), decided once in
   * `followingWorkflow` from `rollup()`. Paint maps it to a class; it does
   * not reconstruct it from `steps`. Optional `step` is the lean progress
   * marker from the session-owned progress file — never invented from the
   * transcript. Absent while every step is still `pending`, so a freshly
   * armed workflow seats a chip that names no cursor.
   *
   * `steps` is the observe-only rail for the drawer: order and labels from the
   * live workflow definition where one is still on disk, and from the progress
   * file's own copies where it is not; status/note/current from progress when
   * usable. No controls ride this list — the panel never sequences steps
   * (runtime §15).
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
      /** At most one; absent when all-pending or progress unusable. */
      current?: boolean;
    }[];
  };
  exchanges: ExchangeView[];
  /** Full recorded history replaces display only; live observation continues. */
  fullHistory?: { exchanges: ExchangeView[]; folds?: FoldView[] };
  /** Older messages are hidden from the live 10-user-turn view. */
  historyAvailable?: boolean;
  /** Messages the panel is holding for this owned session, oldest first. */
  queued?: QueuedView[];
  /**
   * The held messages written to the pipe but not yet in the transcript — the
   * beat `LiveState.sent` exists for, retired by `stillSending`. One row per
   * message a merge folded in, each retiring against its own recorded turn.
   * Drawn exactly like the composer's own echo, so a message crossing from one
   * to the other does not change how it looks. Absent when empty, like `queued`.
   */
  sending?: QueuedView[];
  /**
   * Every request the session is blocked on, oldest first — for a session the
   * panel drives itself, where they arrive on the pipe as control requests.
   *
   * A list, because `initialize` carries `pending_permission_requests` as one:
   * parallel tool calls can leave several open, and a dock that rendered only
   * the first would leave the session blocked on a request nobody can see.
   *
   * The only kind there is: a question reaches the panel on a pipe, or it is
   * answered where it was asked. The dialog hook's overlay used to give a
   * terminal session a staler second copy of one, and answering that copy
   * typed keystrokes at a widget nobody here could see.
   */
  pending?: PendingRequestView[];
  /**
   * Which exchanges fold away behind a "Worked for …" row, one entry per run of
   * work in a settled turn — a turn that spoke between two runs has two, since
   * one row cannot stand in two places. Absent when nothing folds.
   *
   * Decided host-side, because everything it depends on — the exchanges, the
   * status, streaming exchanges, `pending` — is known there and none of it is the webview's.
   * What stays the webview's is whether the reader has opened one, which is
   * state no poll should be able to overwrite.
   */
  folds?: FoldView[];
  /** Turns older than these exist in the transcript but were never read: the
   *  dock reads a tail of the file, not all of it. Drives the notice that says
   *  so, because a thread that simply starts mid-conversation reads as lost. */
  truncated?: boolean;
  /**
   * This thread was read out of the CLI's own transcript rather than out of the
   * record the panel keeps of what it witnessed (roadmap row 54).
   *
   * Drawn as a note, because the difference is one a reader can see and could
   * not otherwise explain: that file's format is observed and not contracted, it
   * is read as a tail rather than whole, and a turn can come out of it shaped
   * slightly wrong. Absent — the ordinary case — means the panel is drawing what
   * it saw arrive.
   *
   * Present for a conversation the panel never held the pipe of, one carried on
   * outside it, and one whose record predates the schema this build reads. The
   * host decides which and ships the answer; nothing here re-derives it.
   */
  fallback?: true;
  /** Folder-discovered canonical names for this session's CLI and opened root.
   *  Absent for an uncontrollable background session; discovery is not proof of invocation. */
  skills?: string[];
  /** Current local pipe reachability, kind, closing and exit; separate from card controls and caller authority. */
  canSend: boolean;
  /**
   * Whether the composer may attach **image bytes** — a paste, which rides the
   * pipe as content blocks. Flattened from the handle's `messages.images`.
   *
   * Not the paperclip, which was gated on this and should never have been: a
   * picked path is the chip's delivery, so it reaches every brand as text and
   * needs no image capability at all.
   */
  canAttach: boolean;
  /** Assistant label on the thread. Paint, not a verb. */
  who: string;
  /** This session's brand's start list. Absent: the composer uses the gear's union. */
  models?: ModelView[];
  /** False when this thread cannot target its next message through messages.send. */
  canModel?: false;
  blockedReason?: string;
  /**
   * Its child has gone. Stated because `canSend` cannot tell the two unsendable
   * cases apart — an ended session and one no window here can reach are both
   * `false` — and `chat.ts` has to: a refusal held about a session that has
   * since ended is a sentence about a send with nowhere left to go, while the
   * same sentence about an unreachable session is still the answer to the click
   * that provoked it.
   */
  ended?: boolean;
}

/**
 * One settled turn's tool rows, collapsed behind a single row. Only the rows:
 * prose stands wherever in the turn it was written.
 *
 * `hides` is a list rather than a span because neither a marker nor a paragraph
 * folds — a skill chip, an interrupt and anything the model said stay standing
 * — so the hidden set has holes in it.
 * The dock owns the words: this carries the elapsed time and whether the reader
 * ended the turn, and `chat.ts` turns those into "Worked for 1m" or "You
 * stopped after 12s" using the same `ago()` every card's stamp goes through.
 */
interface FoldView {
  /** Where the row stands: the first exchange it hides. */
  at: number;
  /** Every exchange index it hides, `at` included, ascending. */
  hides: number[];
  /** How long this run of work took, ms — the gap the row stands in, between
   *  the turns visible either side of it. Absent when neither end was stamped. */
  ms?: number;
  /** The turn ended in an interrupt. On the last run in it, which is the only
   *  one the reader could have cut short. */
  stopped?: boolean;
  /** What the hidden turns wrote, absolute and deduped, in first-write order.
   *  A write turn carries no prose, so it is exactly what a fold hides —
   *  without this the row would hide every pill a long turn produced. Only the
   *  hidden ones: a turn that spoke stands, and draws its own. */
  files?: string[];
  /** How much the hidden turns wrote, summed per file by `core/transcript.ts`'s
   *  `addWritten`. */
  sizes?: Record<string, Written>;
  /** One of the hidden turns had a path left out of its list — see
   *  `AuthoredView.concurrent`. Carried up because a fold that hid the turn
   *  would otherwise drop the marker silently. */
  concurrent?: true;
  /** The baseline tree hash for the pills on this row. Absent when the hidden
   *  turns have none. */
  base?: string;
  /** The same fold across polls, so one the reader opened stays open. */
  key: string;
}

/** Lines added and removed by one turn's writes to one file. Ambient rather
 *  than imported from `core/transcript.ts`: this half of the bundle takes only
 *  `core/markers.ts`, and the wire is where the two halves agree anyway. */
type Written = { add: number; del: number };

type TicketTone = 'urgent' | 'high' | 'medium' | 'low' | 'none';

interface TicketField {
  value: string;
  label: string;
}

interface TicketPriority extends TicketField {
  order: number;
  tone: TicketTone;
}

interface TicketState extends TicketField {
  order: number;
}

interface TicketView {
  scopeId: string;
  /** Opaque source-scoped identity; stable across refreshes. */
  key: string;
  identifier: string;
  title: string;
  priority: TicketPriority;
  state: TicketField;
  url: string;
}

interface TicketDetail {
  scopeId: string;
  key: string;
  identifier: string;
  title: string;
  url: string;
  assignee: AssigneeOption | null;
  state: TicketField;
  description: string;
}

type TicketDetailMessage = {
  type: 'ticketDetail';
  requestId: string;
} & (
  | { state: 'closed' }
  | { state: 'ready'; detail: Omit<TicketDetail, 'description'>; html: string; empty: boolean }
  | { state: 'error'; reason: string }
);

interface AssigneeOption {
  id: string;
  label: string;
}

type StateOption = TicketState;
type PriorityOption = TicketPriority;

interface TicketOptions {
  scopeId: string;
  /** Native person ID, when the source can identify the authenticated viewer. */
  viewerId?: string;
  /** Filter choices: named people and optional `anyone`/`unassigned`; no synthetic `me` row. Empty disables the facet. */
  assignees: AssigneeOption[];
  states: StateOption[];
  priorities: PriorityOption[];
}

interface TicketFilterView {
  /** `anyone` imposes no restriction (including unassigned); `me` retains current-user query semantics. Other values are native person IDs. */
  assignee: string;
  states: string[];
  priorities: string[];
}

type TicketSourceMarkId = 'linear';

interface TicketSourcePresentation {
  label: string;
  mark?: TicketSourceMarkId;
  connectLabel: string;
  connectHint: string;
  reconfigureLabel?: string;
}

interface TicketScope {
  id: string;
  key: string;
  label: string;
}

interface TicketSelectionToken {
  generation: number;
  selectionSeq: number;
  scopeId?: string;
}

interface TicketSourceStatus {
  linked: boolean;
  sourceId: string;
  generation: number;
  presentation: TicketSourcePresentation;
  selectionSeq: number;
  scopeId?: string;
  scopes?: TicketScope[];
  loading?: boolean;
  failure?: 'credentials' | 'service';
  stale?: boolean;
  error?: string;
  options?: TicketOptions;
  filter?: TicketFilterView;
}

/** How much of one rate-limit window is spent. `resetsAt` is epoch seconds. */
interface UsageWindow {
  /** Long name, what the tip prints and the stable key: `session`, `weekly`. */
  id: string;
  /** What the chip prints: `5h`, `wk`. */
  short: string;
  /** A number draws the figure, absent draws `-` (no reading yet), `null` draws
   *  `none` (this brand has no such window). */
  pct?: number | null;
  resetsAt?: number;
  /**
   * When this window was last stated, epoch milliseconds. Per window and not per
   * reading, because one answer can carry a figure for one window and none for
   * the other. Nothing paints this today; it rides along so the two shapes stay
   * one shape, which is what the parity test in `usage.test.ts` is for.
   */
  at?: number;
}

/**
 * The plan's windows, however many this brand states. Account-
 * wide, so this rides on the state message rather than on a card — every card
 * would say the same thing. Either window may be missing on its own.
 */
interface UsageView {
  /**
   * When the reading was taken, epoch milliseconds — the newest of `windows`'
   * own stamps, so it means "when this account was last heard from at all"
   * rather than the age of every figure in the row. The host stamps every
   * reading, whichever source it came from, and ranks them by nothing else. The
   * readout draws the figure and says the age in its tip, the accounts row
   * beside its figures; absent is an age nothing could establish, and draws no
   * age at all.
   */
  at?: number;
  /** Every window this brand states, in paint order. Absent `pct` draws a dash. */
  windows: UsageWindow[];
}

/**
 * Which CLI a row, step or card is about — core's `BrandId`, not a copy.
 * An `import()` here must name a module the webview typecheck can resolve:
 * `core/model` can, `core/workflows/workflows` cannot (it reaches `fs`).
 */
type BrandId = import('../core/model').BrandId;

/**
 * One row of the accounts popover. Every integrated CLI is live
 * (`signed_in` / `signed_out`, or `not_installed` when its binary does not
 * resolve); `coming_soon` remains wire-compatible.
 *
 * `name` and `mark` are what the webview paints. `brand` is the verb token
 * posted back — the webview must not derive a title or a glyph from it.
 */
interface AccountView {
  brand: BrandId;
  /** Display name. Coming-soon title; sheets title off this. */
  name: string;
  /** Paint key for `brandMark`. Unknown → empty wrap. */
  mark: string;
  state: 'signed_in' | 'signed_out' | 'coming_soon' | 'not_installed';
  /** Email, "Signed in", "Not signed in", or "Not installed". */
  label?: string;
  /** Secondary line: `Claude · 4 sessions`, `Coming soon`, … */
  detail: string;
  /** Plan chip when known (e.g. Max). */
  plan?: string;
  /** Nested under a signed-in row when a reading (or window set) exists. */
  usage?: UsageView;
}

/** One CLI's copy of the agent skill. `foreign` is a file at that path we did
 *  not write, or one edited since — the installer leaves it alone. */
interface SkillInstallView {
  /** Display name, as `AccountView.name`. */
  name: string;
  state: 'installed' | 'missing' | 'foreign';
}

/** Phases of an account login sheet. */
type LoginPhase = 'starting' | 'browser' | 'paste' | 'waiting' | 'done' | 'error';

/**
 * One brand's login for a server url. Claude and Grok are separate OAuth
 * clients; a cell is never shared across brands.
 */
type McpActionRef = import('../core/mcp_target').McpActionRef;

interface McpBrandCell {
  /** Exact selected declaration; absence cannot authorize a host action. */
  target?: McpActionRef;
  brand: BrandId;
  /** This brand's configured name — what `startMcpLogin` / `mcpLogout` post. */
  name: string;
  /** Presentation section only; target retains the original declaration cwd. */
  root?: string;
  /** "Claude" / "Grok" — paint, never derived from `brand`. */
  label: string;
  /** Paint key for `brandMark`. */
  mark: string;
  /**
   * `busy` and `error` are the in-flight login. `ok` and `needs` come off disk.
   * `broken` and `pending` come from `claude mcp list` and only after someone
   * has asked for it — a cell with no answer yet stays on its disk state.
   *
   * **`pending` takes neither verb.** It is a `.mcp.json` server nobody has
   * approved: it does not load into a session, and `claude mcp login` refuses
   * it. There is nothing to authorise and nothing to disconnect.
   *
   * **`unknown` is an answer, not a missing one.** Codex reports `auth_status:
   * "unknown"` for a server it holds no credential for and has not been asked
   * about, and a cell says so rather than guessing `ok` from the fact that
   * somebody configured it.
   */
  state: 'ok' | 'needs' | 'busy' | 'error' | 'broken' | 'pending' | 'unknown';
  /**
   * False keeps the cell and drops the button — this host cannot run that
   * brand's login.
   */
  supported: boolean;
  /**
   * Whether *this* cell's credential is ours to remove.
   *
   * **Connected is not the same fact as "we hold the grant".** A Codex server
   * authenticated from a configured bearer token reports connected and owns no
   * credential we could take; a STDIO server has no auth at all. Deriving the
   * verb from `state` said Disconnect for both.
   *
   * Stamped at each brand's own seam, because which credentials a brand owns is
   * that CLI's fact and not something the sheet can work out.
   */
  canDisconnect: boolean;
  /** The secondary line when the state alone is not the whole story. */
  note?: string;
  /** The authorize url, only while this cell's login is in flight. */
  url?: string;
  /**
   * **Neither verb applies to this cell.** There is no entry to remove and no
   * login to start — where it comes from is `McpRow.fromAccount`, at the seam
   * that reads it.
   */
  fromAccount?: boolean;
}

/**
 * One MCP server on the sheet: something the repos on the board configure, and
 * one cell per brand that lists it.
 *
 * **A row is a key, not a name.** Each brand keys a token by name and url, so
 * two repos naming one url share one login per brand and appear once, with
 * both named in `projects`. A transport with no url is its own row and joins
 * with nothing.
 */
interface McpServerView {
  name: string;
  /**
   * The row's identity, and not paint — `host` is what a cell has room for.
   *
   * **A url is no longer enough to be one.** An HTTP row still keys by url, so
   * two repos naming one url share one login per brand and appear once. A
   * Codex STDIO server has no url at all, and its command line is the one
   * thing that must not cross this wire, so it keys on brand, scope, root and
   * configured name instead. Composed host-side; anything keying a row across
   * a repaint keys on this and never on the url that may not be there.
   */
  key: string;
  /**
   * What a cell has room for: an HTTP row's host, or `STDIO` and a command
   * basename for one that has no host.
   *
   * Never the full command line. Arguments and environment name secrets, and
   * this string is drawn.
   */
  host: string;
  /** Basenames of the repos that reach it. Empty when only Grok lists it. */
  projects: string[];
  brands: McpBrandCell[];
  /**
   * How *this section's* repo declares it. One url is `local` in one repo and
   * `project` in another, so it rides on the copy in a group and not on a row
   * shared between them.
   */
  scope?: McpScopeId;
  /**
   * The chip's word. Composed host-side with everything else that spells a
   * CLI's own vocabulary; `scope` stays for paint that needs the value rather
   * than the word.
   */
  scopeLabel?: string;
  /**
   * The other repos on the board reaching this same url, by basename. One
   * login, keyed by url, so a Disconnect here takes theirs too — which is the
   * whole reason the tag exists.
   */
  alsoIn?: string[];
}

type McpScopeId = 'local' | 'project' | 'user';

/**
 * One section of the sheet: a repo on the board, or the trailing section for
 * what belongs to no repo.
 *
 * **A section is a page, and the fold joins within one.** Claude and Grok are
 * joined by url inside a section, never across two — a repo's `linear` and
 * Grok's *user* `linear` are two different declarations that happen to share
 * a url. A project `.grok/config.toml` is that repo's and joins on its page.
 */
interface McpGroupView {
  /**
   * The repo root, and the identity of the section. Empty for the trailing
   * one, which is the only section with no root and the only one that can
   * repeat that.
   */
  root: string;
  /** The repo's leaf name, or the trailing section's own title. */
  label: string;
  /** The second line under an open head: where this is on disk. */
  path?: string;
  /** This window's own repo. Sorted first, and open when the sheet opens. */
  here?: boolean;
  /**
   * What to say when the section has nothing. Composed host-side: every
   * version of it spells a CLI command (`claude mcp add`, `grok mcp add`,
   * `.mcp.json`).
   */
  emptyLine?: string;
  servers: McpServerView[];
}

/**
 * The MCP sheet, and the one line the accounts popover still draws.
 *
 * Absent until the first read — an unreadable config leaves the popover
 * exactly as it was before MCP shipped.
 */
interface McpView {
  /**
   * The sheet, in order: this window's repo, the rest of the board's by name,
   * and what belongs to no repo last.
   */
  groups: McpGroupView[];
  /**
   * The line under the sheet head. Composed host-side because what it says
   * depends on a CLI's own vocabulary, which does not belong in `webview/`.
   */
  hint?: string;
  /**
   * The popover footer. Absent when there are no servers. Names what is
   * broken (`Slack needs Grok`) or says they are all connected.
   */
  summary?: string;
  /**
   * Whether that line is asking the reader for something they can do from here,
   * which is what the footer's amber means.
   *
   * A separate flag rather than the webview matching on `summary`: the sentence
   * spells a CLI's own vocabulary and is the host's to word. False for all
   * connected, and for a server awaiting approval — that is settled in its own
   * repo, not from this footer.
   */
  summaryWants?: boolean;
}

/**
 * The machine the sessions share. Account-wide in the same sense `UsageView`
 * is — every card would say the same thing, so it rides on the state message.
 *
 * Each reading's absence is a wait and nothing else: the nav draws it as one
 * being fetched. `cpu` is 0–100 across every core, absent until a second tick
 * sample is far enough from the first to diff — after a start, or a resume from
 * sleep. `memory` is absent until the first read settles, and `null` once one
 * has settled with no honest answer (`readMemory`), which the nav draws as "-".
 * Neither waits for the other.
 */
interface MachineView {
  cpu?: number;
  memory?: MemoryView | null;
}

/**
 * How much of the machine's RAM is in use. **Bytes, not a percentage** — the
 * dial's fill wants the ratio and the figure beside it wants the absolute, so
 * the wire carries what both are derived from.
 *
 * What the host OS means by "in use" differs per platform, and every version of
 * the question is answered in `docs/reference/machine_memory.md`. Absent
 * wherever there is no honest answer. `total` is installed RAM, or a container's
 * ceiling where there is one.
 */
interface MemoryView {
  used: number;
  total: number;
}

/**
 * The coffee holding this machine awake, machine-wide in the same sense
 * `MachineView` is — every card would say the same thing, so it rides on the
 * state message rather than on any card.
 *
 * **The level is not on the wire, and that is the point.** It used to be: a
 * `fill` of `(until - now) / LEASE_MS`, recomputed host-side against a moving
 * `now` twenty times a minute so the cup could slide. Since no two pushes could
 * ever carry the same one, it made every state message differ from the last and
 * so made a post dedupe impossible — see
 * `docs/tasks/TASK_done_panel_repaint_cost.md`. The two facts it was
 * derived from ride here instead and the division moved to `webview/cafe.ts`,
 * onto the 1s beat that was already running. The cup animates at 1 Hz rather
 * than 0.33 Hz as a side effect, which is better than what it replaced.
 *
 * The lease `until` is a share of is **not** here either, and for the opposite
 * reason: it is a constant both halves compile against (`ui/lease.ts`), and a
 * constant put on a wire is marshalled to itself.
 *
 * Absent takes the cup away entirely — a platform with no `caffeinate`, or the
 * setting off. A cup that is present but permanently empty would be noise, and
 * absence is the answer `readMemory` already models for a reading there is no
 * honest version of.
 *
 * **Two arms, because there are two states and they carry different facts.**
 * Something is being held for, and then there is a deadline and a count; or
 * nothing is, and the reason is the whole of it. One flat shape with both
 * optional described four states the host cannot produce, and the cup paid for
 * it downstream — `(until ?? 0) - now` is not a default but a sentinel that
 * lands on minus the epoch and gets translated back by the `<= 0` branch. The
 * union deletes that rather than testing around it, and `reason` narrows for
 * free wherever it is already switched on.
 */
type AwakeView =
  | {
      reason: 'drinking';
      /** When the last lease runs out, epoch ms — merged across every window
       *  holding, so it is the latest and not the newest writer's. */
      until: number;
      /** Sessions held for, counted once across every live lease, as each was
       *  poured — so up to a lease old. */
      sessions: number;
      /** A live lease was poured with Remote on, in whichever window holds it. */
      remote?: true;
      /** Sessions a live lease holds for their next warm ping, counted once
       *  across every live lease. Absent is none. */
      warmSessions?: number;
    }
  | {
      /** Why nothing is being held. A cup drawn empty, which is not absence. */
      reason: Exclude<AwakeReasonView, 'drinking'>;
    };

/**
 * Why the machine is or is not being kept awake. Mirrors `AwakeReason` in
 * `core/awake.ts` — `unsupported` and `off` never reach the panel, since both
 * take the whole view away.
 */
type AwakeReasonView = 'drinking' | 'idle' | 'stale' | 'battery' | 'off' | 'unsupported';

/**
 * One row in a group's servers section — **one per branch, not per process.**
 *
 * A branch with nothing running still has a row, carrying the port it used last
 * so _Run_ has a default; that is why `status` is optional and `remembered` is
 * not the same thing as `port`. `port` is what is live now, `remembered` is what
 * this branch picked before and confers nothing.
 *
 * Every row is this window's: a terminal it holds, or a listener one of its
 * sessions is running (`sessionRows`, `ui/server_views.ts`). That is why this
 * carries no window of its own since row 71.
 */
interface ServerRowView {
  /** The tree this row is about; `cwd` is where it starts. */
  branch: string;
  /** That tree's path. The servers sheet groups rows by it. */
  tree: string;
  cwd: string;
  runnerId: string;
  /**
   * The word slot: one word after the branch and the port. Idle, it names the
   * runner; running under a monorepo it names the app, because *which app*
   * is what tells two rows of one branch apart and the runner label does not.
   * `portless` and `unrunnable` spend the same slot on their own labels.
   */
  label: string;
  /**
   * The tree-relative directory this server runs in — `apps/admin` — set only
   * when it is not the tree root, so a plain repo never carries it.
   *
   * Composed host-side rather than derived here: the webview has no `path`, and
   * two rows of one branch are told apart by which app they are, which no
   * amount of `label` can say once every app's label ends `npm run dev`.
   */
  app?: string;
  /** Absent when nothing is running — the row is a branch, not a process. */
  status?: 'starting' | 'up' | 'failed';
  /**
   * A listener on this row's `port` that an owned session is running.
   *
   * Present implies `port` and `url` are, and implies `status` is **absent**:
   * we never probed it, so the row makes no claim about its health. `startedAt`
   * is the process's native start, which the ✕ hands back as its check. `command`
   * is empty where the OS's reading gave none. `session` is the card's name.
   */
  listener?: { command: string; pid: number; startedAt: number; session: string };
  port?: number;
  url?: string;
  /** What this branch picked last time, drawn dashed when nothing is up. */
  remembered?: number;
  /** Why it failed, in the words the row prints — `port taken`, `port in use`. */
  reason?: string;
  /** The command carries no measured port flag, so the port may be ignored. */
  guessed?: boolean;
  /** Takes no port at all — the extension dev host, which opens a window. Run
   *  starts it outright: there is nothing to pick. */
  portless?: boolean;
  /** Nothing here can be started: no obvious script, or two of them. The row is
   *  still drawn — the section lists every branch — and says so instead of
   *  offering a button that would refuse. */
  unrunnable?: boolean;
  /**
   * The candidate scripts detection found and refused to choose between —
   * `['dev', 'start']`. Present only on an `unrunnable` row, and the reason that
   * row is a button after all: two scripts the repo declared itself is a
   * question to ask, not a guess to make, and the sheet is where it is asked.
   *
   * Names rather than runners: the line has room for a count and the tip for a
   * list, and the commands themselves are the sheet's business
   * (`startsFor`) — a board row that carried them would be shipping the same
   * strings twice.
   *
   * Never set beside `workspaces` — `serverRows` (`ui/server_views.ts`) is where that
   * is dropped, and why.
   */
  candidates?: string[];
  /**
   * This tree declares workspaces, so the sheet has something to offer even when
   * the root resolves to no runner of its own.
   *
   * Set from the poll, which asks the cheap question only (`declaresWorkspaces`)
   * — it never walks the tree. Without it an ambiguous-root monorepo draws
   * `unrunnable`, which is not a button, and the sheet listing its apps could
   * never be opened.
   */
  workspaces?: boolean;
}

interface GroupView {
  label: string;
  app: string;
  cwd: string;
  sessions: CardView[];
  /** Folder discoveries resolved for this draft launch cwd, indexed by CLI. */
  skillsByBrand?: Partial<Record<BrandId, string[]>>;
  /** How to lay `sessions` out, never what is in it: every card stays in
   *  `sessions` whether or not a family names it, because the nav tally, the
   *  status filter and the waiting pills all read the flat list. Absent or empty
   *  means the flat grid — a machine that has never spawned anything, and a
   *  group whose last box has dissolved down to one card. */
  families?: FamilyView[];
  /** Top-level slots in render order: a loose card's pid, or the pid of the
   *  card a family box is headed by. Absent when this group has no stored
   *  arrangement, which is the common case and today's render path. Never a
   *  statement about membership — every card is still in `sessions`. */
  slots?: number[];
  /** This repo's trees, one row each. Absent or empty draws no section, which
   *  is every group whose folder is not a repository. */
  servers?: ServerRowView[];
}

/**
 * One box in the grid: a whole fan-out, and the members of it that are in *this*
 * group.
 *
 * Grouped by the stamp every spawn carries (`originSessionId`), so a chain of
 * four generations is one box rather than three overlapping ones, and the box
 * outlives the session that started it. `parent` is the card the box is *headed
 * by*: the origin's own card when it is running, and the earliest-started member
 * when the origin has closed — a closed session leaves no card to name a box
 * with. `members` holds the head first when its card belongs here, then the rest
 * by ascending `startedAt`; a box whose head is elsewhere, or is already a member
 * of another box, holds only the members that are here.
 *
 * A box needs two members unless its head is running: the last survivor of a
 * fan-out is a loose card, because a heading naming the only card inside it says
 * nothing the card does not.
 */
interface FamilyView {
  parent: number;
  members: number[];
}

/**
 * One step as the panel may author or peek it.
 *
 * `prompt` crosses so the editor can open a file without a second fetch.
 * `check.command` and other shell-shaped fields do **not** — a webview holding
 * a shell command is a webview that could be asked to show one. Attach chips
 * only draw `label`; the host still owns execution (session-owned runtime).
 */
interface WorkflowStepView {
  id: string;
  label: string;
  /** Body the session is told. Empty string when the file had only `uses` and
   *  the view put that slash line here for display/edit. */
  prompt: string;
  /**
   * What the canvas places, and what a chip writes back. Absent lane is the
   * armed session; an empty `needs` is "no edge". `brand` is the picked row's,
   * copied whole — the webview does not derive it from `model`.
   */
  lane?: string;
  needs?: string[];
  brand?: BrandId;
  model?: string;
  effort?: string;
}

/**
 * One authored workflow, as a picker row and as an editor load.
 *
 * The workflow's own file path rides out nowhere at all. It is not on this type,
 * and since step-blind delivery it is not in the enriched message either — that
 * line names the label and the id (`core/workflows/workflows.ts` `enrich`), and the steps
 * reach the session one at a time through `squadron-step`.
 *
 * **A run does not cross the wire.** Provenance lives under `runs/` on the host.
 */
interface WorkflowView {
  /**
   * Absent here on purpose. An edit carries `repair: true`, and that value is
   * not assignable to this, so the runnable list cannot hold one by accident.
   */
  repair?: undefined;
  id: string;
  label: string;
  /** The file's lane order (`Workflow.lanes`). Absent draws by run order. */
  lanes?: string[];
  steps: WorkflowStepView[];
}

/**
 * A file `validate` refused for its graph, as the editor can open it.
 *
 * Not a `WorkflowView`: nothing arms or mentions one. `reasons` are the
 * sentences the cards draw. The file path stays on the host.
 */
interface WorkflowEditView {
  repair: true;
  id: string;
  label: string;
  lanes?: string[];
  steps: WorkflowStepView[];
  reasons: string[];
}

/**
 * One row of the model list, as `core/catalog.ts` writes it down.
 *
 * Both visible lines are ours now — `name` above, `id` below — because no CLI
 * answers this any more. `id` is per-row *display* rather than a canonical id:
 * both Opus 5 rows resolve to `claude-opus-5`, and printing that under both
 * would draw two rows a reader cannot tell apart.
 *
 * **These rows are already filtered for brand availability.** The host drops a
 * brand with no binary, or one it knows is signed out, before the push — so
 * nothing here asks whether a brand is usable, and no brand check enters
 * `webview/` (root `AGENTS.md`).
 */
interface ModelView {
  /** What the host hands the CLI. **Opaque here** — which flag it becomes is
   *  the adapter's business, and nothing in `webview/` may parse it, split it
   *  or guess a brand from it. */
  value: string;
  /** What a reader calls it — `Opus 5`, `Grok 4.6`. **No window in it**, and
   *  therefore not unique: the two entries of a model share this and differ by
   *  `window`. A surface holding one value composes its own `(200k)` half with
   *  `ctxLabel`; the menu draws the windows beside the name instead. */
  name: string;
  id: string;
  /** Stamped host-side for routing, the key rows are run together on, and the
   *  mark a row draws beside its name — the same three jobs `CardView.brand`
   *  does, and `brandMark` takes it as an opaque paint key with an empty wrap
   *  for an unknown one. What it is never is a *check*: nothing in `webview/`
   *  may ask which brand this is and do something different (root `AGENTS.md`).
   *  It read "never read in `webview/`" while the flyout was already grouping
   *  on it. */
  brand: BrandId;
  /** What to call that brand over its run of rows — "Claude", "Grok". Optional;
   *  what an absent one draws is `modelItems`' to say (`board_settings.ts`). */
  brandLabel?: string;
  /**
   * Every spelling a live reading of this row may arrive as. **Read and never
   * painted**, as `brand` is — this is `resolveModel`'s join key, and it is on
   * the wire because the tick is drawn here: `modelInForce` runs in the panel,
   * over these rows, so a key that stopped at the host would be a join that
   * never happens in the product.
   */
  readings?: readonly string[];
  /** What the flyout folds away behind one row per brand; absent for a current
   *  model. What the flag means is `CatalogRow.legacy`'s to say
   *  (`core/catalog.ts`). */
  legacy?: true;
  /**
   * Native effort values in the source's order. Both `value` and the optional
   * source-stated `description` are opaque: `webview/` paints them and never
   * maps or parses them.
   */
  efforts?: readonly { value: string; description?: string }[];
  /** The native default this row's source stated, painted but never inferred. */
  defaultEffort?: string;
  /**
   * This window is offered and may still be refused — a billing gate on a
   * variant the account has, not a variant it lacks.
   *
   * Drawn dashed rather than dimmed, and **still pressable**: `.off` promises
   * drawn-dimmed-and-unpickable, and this is a different promise. What comes
   * back is a 400 in that session's own thread, which is where a reader can do
   * something about it. What the flag means is `CatalogWindow.gated`'s to say.
   */
  gated?: true;
  /**
   * This window cannot be reached by switching **this** session onto it — the
   * launch line's doing, not the account's, which is the whole difference from
   * `gated` above.
   *
   * Drawn `.off`: dimmed and unpickable, where `gated` is dashed and still
   * pressable. An entry carrying both draws as this one — a certainty over a
   * maybe. **Dock only**, so nothing in the gear's flyout is ever fixed.
   *
   * What the flag means is `Model.fixed`'s to say (`core/model_names.ts`).
   */
  fixed?: true;
  /**
   * The context window this row runs in, in tokens.
   *
   * **The second half of the key.** `value` alone no longer names one row:
   * since `core/catalog.ts` flattened to one entry per (model × window),
   * `claude-opus-5` is both the 1M row and the 200k one, and a menu that ticked
   * on `value` would tick both. Every join here takes the pair.
   *
   * A number, and deliberately not a label — `200k` is composed in `webview/`
   * where it is drawn (`ctxLabel`). A label crossing the wire would be a second
   * source for a string the panel already knows how to build, and the two only
   * agree until somebody changes one.
   *
   * Absent for a row the catalog states no window for — a typed id. Such a row
   * still starts a session; it starts one in whatever window the account gives
   * it, which is what this field exists to stop being the only option.
   */
  window?: number;
}

/** Full replacement for one selected conversation; sequence is publication order,
 * not a content-delta cursor. The select request fences A → B → A and reloads. */
type ThreadPublication = {
  selection: string;
  generation: number;
  sequence: number;
  revision?: number;
};

type ThreadMessage = ThreadPublication & {
  type: 'thread';
  thread: ThreadView;
};

/** Content revision is distinct from delivery sequence and record-page cursor. */
type ThreadPatchMessage = ThreadPublication & {
  type: 'threadPatch';
  pid: number;
  startedAt: number;
  base: number;
  revision: number;
  changes: Partial<Omit<ThreadView, 'exchanges'>>;
  unset: (keyof Omit<ThreadView, 'exchanges'>)[];
  splice: { at: number; remove: number; exchanges: ExchangeView[] };
};

type StateMessage = {
  type: 'state';
  groups: GroupView[];
  /** Effective launch directory: first IDE folder, otherwise the managed scratch root.
   * Independent of session directories and the repo roots used to group cards. */
  defaultCwd?: string;
  defaultSkillsByBrand?: Partial<Record<BrandId, string[]>>;
  /** Combined recovery snapshots may carry the same publication fence. Omission
   * preserves the selected thread; select/close are the explicit clear paths. */
  thread?: ThreadView;
  threadPublication?: ThreadPublication;
  /**
   * Machine-wide accounts list (Claude and Grok live; Codex coming soon). Absent
   * until the first auth status poll lands — nav keeps usage-only behaviour
   * until then. Always three rows once present.
   */
  accounts?: AccountView[];
  /**
   * The windows the plan-usage chip will have, sent only while `accounts` is
   * absent, so the chip can hold its labels while the readings are fetched. The
   * host's spelling, never the webview's: which windows exist is a brand's to
   * declare, and no brand is known before the first auth poll lands.
   */
  usageWindows?: { id: string; short: string }[];
  /** Open the onboarding dialog: this install has not finished it, and the
   *  first auth poll has landed, so its setup rows say what is installed. */
  onboarding?: boolean;
  /** Whether each CLI has our agent skill, for onboarding's Orchestration
   *  slide. One row per brand whose CLI directory exists; a brand with none
   *  has nowhere to put it and is left out. */
  skillInstall?: SkillInstallView[];
  /**
   * The MCP servers the repos on the board configure. Absent until the first
   * read lands, and absent for good when `~/.claude.json` will not parse — the
   * accounts popover then draws exactly what it drew before this shipped.
   */
  mcp?: McpView;
  /** How busy the machine itself is. Absent until either reading exists. */
  machine?: MachineView;
  /** The coffee keeping this machine awake. Absent draws no cup at all — off
   *  this platform, or with the setting off. See `AwakeView`. */
  awake?: AwakeView;
  /** Where the reader dragged the cup, as an offset from the board's
   *  bottom-left corner. Absent is the default corner. */
  cafeAt?: { x: number; y: number };
  /** Remote in this window, in decided words (`ui/remote_view.ts`). Absent
   *  until the first view resolves, and in a host without `RemoteHost`. */
  remote?: RemoteStateView;
  /** Whether the café is on: the cup, and the hold it draws. **Defaults on**,
   *  unlike every other flag here — it is here so the switch has a state to
   *  show, since `awake` being absent cannot distinguish "off" from "not a
   *  mac". */
  cafe: boolean;
  /** Whether Remote, in the window holding it, keeps the machine awake with
   *  nothing working. **Defaults on**, for `cafe`'s reason. */
  cafeRemote: boolean;
  /** Whether a session with Warm on keeps the machine awake with nothing
   *  working. **Defaults on**, for `cafe`'s reason. */
  cafeWarm: boolean;
  /** A session in this window has Warm on. This window's
   *  fact, as the keeper's hold is this window's; as fresh as this push. */
  warmOn: boolean;
  /** Whether a session may start another session and hand it a task. Changes
   *  nothing the panel draws — it gates the request handler, which runs with
   *  no panel open. Here so the switch has a state to show. */
  orchestrators: boolean;
  /** Whether a session started from here launches without permission prompts.
   *  Like `orchestrators`, nothing drawn depends on it — the host reads the
   *  setting when it starts a session. Here so the switch has a state to
   *  show. Only sessions started after a change are affected. */
  skipPermissions: boolean;
  /** Whether new sessions in this window capture tool execution. Off stops
   *  capture in sessions already running. Here so the switch has a state to
   *  show — the host reads `checkpoints.execution.enabled` at start and on
   *  change. */
  executionCapture: boolean;
  /** Whether the panel sounds a cue when a session finishes or blocks, and how
   *  loud. Drives nothing drawn — the host withholds the cue itself at `off`,
   *  and this is here so the row has a value to show. */
  soundLevel: SoundLevel;
  /** Whether the servers line is drawn at all — the one experiment behind the
   *  gear. Unlike the flags above it this really does gate a draw, but not
   *  here: with it off the host gathers no server context, so every group
   *  arrives with no rows and there is nothing for `board_servers.ts` to
   *  decide. Here so the switch has a state to show. */
  devServers: boolean;
  /** Whether the chick is on the board — the mascot experiment behind the
   *  gear. Off means nothing is mounted and nothing listens
   *  (`webview/mascot.ts`). Every fact it reacts to is already on this
   *  message, so the host gathers nothing for it. */
  mascot: boolean;
  /** Whether a new session starts kept warm — the warm list's last row. A
   *  session's own choice outlives a change here. */
  warmCache: boolean;
  /** The figures Warm's configuration column shows, read off the
   *  `squadron.warmCache.*` settings every pass. */
  warmConfig: WarmConfigView;
  /** The theme setting, echoed so the picker shows the truth and a change made
   *  in the Settings UI reaches the panel. The webview paints its own picks
   *  before this arrives; this only reconciles. */
  theme: ThemeName;
  /**
   * What a new session starts on, or `''` for the account's own default.
   *
   * The gear's own value, and where every start *begins*: a draft's model pill
   * opens on it, and a resume that has no control of its own passes it only
   * when it belongs to that conversation's brand. What a start finally runs on is stated on that start's own
   * message — a draft that picked something else carries the pick and leaves
   * this alone — and a card states the model its session is *actually* running,
   * read off the transcript. All three are allowed to disagree.
   */
  model: string;
  /**
   * The window that row is set to, in tokens — the other half of the pick, and
   * what lets the menu tick one of two rows sharing a `value`.
   *
   * Absent means the setting is unset, which is not the same as "the first
   * window": such a start names no window at all and takes whatever the account
   * gives, exactly as it did before this existed.
   */
  contextWindow?: number;
  /**
   * `squadron.efforts`: how hard a start this panel makes is to think, per
   * model `value`, in that model's native spelling.
   *
   * Here for the same reason `model` is: it is what a *new* start opens on, and
   * the start itself states the answer. `startOwned` reads no setting, so a
   * value that does not reach a draft or the resume picker reaches no session.
   *
   * Keyed by model because effort belongs to one: a single value had to be
   * reset on every model pick, so switching away and back lost it. A model
   * with no entry, or one its row does not advertise, opens on the row's stated
   * default — absent that, no override, never a translated value.
   */
  efforts: Readonly<Record<string, string>>;
  /**
   * Every model this machine can start a session on, as the installed CLIs
   * answer it — already filtered to the brands with a binary and an account
   * (`offeredModels(brandAvailability(...))`), and already in the catalog's own
   * rank. Empty is a machine with no brand it can run, which the gear's flyout
   * and the draft's menu both draw as such — it is never filled in with names
   * of our own.
   */
  models: ModelView[];
  /** The backlog for the tickets tab; absent until a source is linked. */
  tickets?: TicketView[];
  /** The ticket source's connection/health; absent reads as unlinked. */
  ticketSource?: TicketSourceStatus;
  /**
   * The workflows on this machine.
   *
   * Absent or empty is the machine that has authored none. The bar still draws
   * as **+ New workflow** alone so first create is not “hand-write JSON”; arming
   * chrome (picker + switch) arrives only when there is something to arm.
   * Empty is different from absent only in that it says the directory was there.
   *
   * **Already in the reader's order, and no surface may re-sort it.** The host
   * folds `workflows.order.json` over the directory once, in `buildState`, so
   * every painter of this array agrees by construction rather than by each
   * remembering to sort the same way. What is not stated sorts by label, which
   * is the floor a machine with no file gets.
   */
  workflows?: WorkflowView[];
  /**
   * Structurally broken files the editor can open. Not workflows: nothing
   * arms, pins, or mentions one. Absent or empty is a machine with none.
   * Drawn after `workflows` on the sheet, and kept off `seen`.
   */
  workflowEdits?: WorkflowEditView[];
  /** Sorted union of global and this window's opened-root discoveries for the workflow editor. */
  skills?: string[];
};
/**
 * What became of a `send`, and of an unrouted interrupt, rename or dismiss.
 *
 * `text` is what actually went on the wire, and it is present on the accepted
 * paths only. It is not always what was typed: a send carrying a `workflowId` is
 * enriched host-side, so the CLI writes down the workflow line with the typed
 * subject beneath it. The dock echoes the message until the transcript shows it,
 * and that match is against what the CLI wrote — so without this the echo of
 * every mention is matched against a subject that is a *suffix* of the real
 * turn, and never settles.
 */
type SendResultMessage = {
  type: 'sendResult';
  pid: number;
  /** The originating webview operation. Absent for legacy/unrouted notices. */
  operationId?: string;
  /** Process incarnation the operation addressed. */
  startedAt?: number;
  ok: boolean;
  reason?: string;
  text?: string;
};

/**
 * What became of one `respond`: the answer to a dialog, reported back to the
 * dialog that sent it.
 *
 * There is no acknowledgement to wait for further down — a `control_response`
 * on the pipe *is* the reply to the CLI's own request, and nothing comes back
 * for it — so `ok` means the host got the answer onto this session's pipe. That
 * is the whole of what the panel can know, and it is the part it could not see
 * before: a webview post is fire-and-forget, so a dialog frozen on a click had
 * nothing to unfreeze it but the next state push.
 *
 * `ok: false` is a decision that went nowhere — a request withdrawn first, a
 * session that ended — and hands the dialog straight
 * back rather than leaving it dead behind a host toast the reader may have
 * muted. `reason` is for saying so where the decision was made.
 */
type RespondResultMessage = {
  type: 'respondResult';
  pid: number;
  startedAt: number;
  requestId: string;
  ok: boolean;
  reason?: string;
};

/** Host asks the webview to open a session's detail dock, e.g. from a toast. */
type RevealMessage = {
  type: 'reveal';
  pid: number;
  startedAt: number;
  /**
   * The draft this start answers, when it answers one.
   *
   * Present only on a reveal for an `open` that carried a draft id. It is what
   * promotes: the webview copies that draft's text, images, files and workflow
   * id onto this pid, posts the ordinary `send`, and drops the draft. Absent
   * keeps every other reveal on its existing path — a resume, or an
   * `squadron-spawn` this window served.
   */
  draftId?: string;
};

/** A negative reply without no-start proof remains unknown, including legacy replies. */
type OpenResultMessage = {
  type: 'openResult';
  draftId: string;
  ok: boolean;
  reason?: string;
  unsure?: true;
  notStarted?: true;
};

type StartupStatusMessage = {
  type: 'startupStatus';
  attemptId: string;
  state: 'waiting' | 'unknown' | 'stopped' | 'started';
  stage?: string;
  reason?: string;
  pid?: number;
  startedAt?: number;
};

type ResumeResultMessage = { type: 'resumeResult'; requestId: string; attemptId?: string } & (
  | { ok: true; pid: number; startedAt: number }
  | { ok: false; reason: string; unsure?: true; notStarted?: true }
);

/**
 * Sessions whose End the host accepted, whoever asked: the panel, a self-end,
 * Remote, a signal that reached a session no pipe here closed, or dismissal
 * of an already-exited session.
 *
 * Absence from a state push is not enough: discovery may omit a live session
 * once, while a confirmed End is a navigation event that closes its active
 * chat. The start stamp keeps a late result away from a recycled pid.
 */
type CloseResultMessage = {
  type: 'closeResult';
  sessions: { pid: number; startedAt: number }[];
};

/**
 * The bytes behind an `ImageRef`, answering one `image` request.
 *
 * A refusal carries why, because both reasons have something better to say than
 * a broken picture: `gone` is a file that was pruned or moved, and `tooLarge` is
 * an image this will not inline at all — there is no downscaler here without a
 * runtime dependency, so past a ceiling the chip offers to open it instead.
 */
type ImageDataMessage = {
  type: 'imageData';
  id: string;
  dataUrl?: string;
  reason?: 'gone' | 'tooLarge';
};

/**
 * One page of a directory's past conversations, as picker rows.
 *
 * Answers one `listConversations`, so it is a reply and not a field on the
 * state: nothing on the board depends on it, and a repaint every three seconds
 * should not re-read a directory of transcripts nobody has asked to see.
 *
 * `snapshotId` names the ranking the host froze for this open; every later page
 * is a slice of it, so activity moving while the reader scrolls cannot
 * duplicate or skip a row. `offset` 0 replaces the list, any other appends.
 * `next` is absent at the end of the list and at the 500-row limit, where the
 * picker offers no more pages and search still reaches every row.
 */
type ConversationsMessage = {
  type: 'conversations';
  requestId: string;
  cwd: string;
  snapshotId: string;
  offset: number;
  rows: ConversationView[];
  next?: ConversationCursor;
  /** The host no longer holds that snapshot: ask for page 1 again. */
  expired?: true;
};

/** A place in one open's frozen ranking (or in its query's view of it). */
type ConversationCursor = { snapshotId: string; offset: number };

/**
 * One row of that list.
 *
 * `title` is a name somebody stated for this conversation when `titled`, and
 * the conversation's opening prompt when not — so a row can show the difference
 * rather than pass a prompt off as a title. No CLI's own guess reaches here:
 * these rows are read from our transcript store, not from a CLI's.
 *
 * `running` is a conversation whose session is alive right now. It is shown and
 * not hidden, because the reader is looking for exactly this conversation and a
 * gap where it should be reads as lost. Resuming it would put two children on
 * one transcript, so the row opens its card instead.
 */
type ConversationView = {
  sessionId: string;
  brand: BrandId;
  title: string;
  titled: boolean;
  /** When it last said anything, epoch ms — the age is phrased in the webview
   *  from this, exactly as `CardView.updatedAt` is, so a sheet left open keeps
   *  telling the truth about how old a row is. */
  lastActivity: number;
  branch?: string;
  running?: boolean;
  /**
   * Where this conversation has to be resumed — which is not always the folder
   * that was asked about. A repository is many working directories and the
   * board folds them into one group, so the list spans every checkout; the CLI
   * finds a session id only under its own cwd's slug, so the row carries the
   * one it was filed under rather than inheriting the picker's.
   */
  cwd: string;
  /** That directory named for a reader, set only when it is not the folder
   *  asked about — what tells two rows on the same branch apart. */
  where?: string;
};

/** Host -> webview. */
/**
 * Something worth hearing happened to a session: `done` is a reply finished,
 * `blocked` is a question or a permission prompt waiting on a person.
 *
 * Its own message rather than a field on the state, because a cue is an edge
 * and the state is a level: the panel repaints every few seconds, and anything
 * carried on a repaint would sound again on each one. The host decides which
 * pids crossed and sends at most one of each per poll — see `soundCue`.
 */
type SoundMessage = { type: 'sound'; cue: SoundCue };
type SoundCue = 'done' | 'blocked';

/** A loudness the cues can actually sound at. A slider was the alternative:
 *  the panel has none, and a drag would write machine-wide configuration on
 *  every frame of one. Scaled in `webview/sound.ts`. */
type SoundVolume = 'quiet' | 'normal' | 'loud';

/** That, plus silence — the whole of what the reader picks about sound, since
 *  turning the cues down far enough and turning them off is one gesture. Held
 *  host-side as `squadron.sound.level`. */
type SoundLevel = 'off' | SoundVolume;

/**
 * Whether anybody is looking at this panel.
 *
 * **It cannot be a field on the state**, for the reason `SoundMessage` above
 * cannot be one either, arrived at from the other side: a hidden panel is
 * exactly what stops the state going out (`refreshOnce`'s gate), so the news
 * that nobody is looking would be riding the thing it suppresses.
 *
 * The webview needs telling because it cannot see this for itself.
 * `retainContextWhenHidden` keeps the document alive and a tab switch never
 * touches it, so `document.visibilityState` reports the *window* — it goes
 * hidden when the IDE is minimized and stays visible behind another tab.
 * `panel.visible` is the exact opposite. Neither means "nobody is looking"
 * alone; the beat in `main.ts` wants both, which is why this is sent rather
 * than inferred.
 *
 * A fresh document is always a visible one — `retainContextWhenHidden` means a
 * hidden panel is never rebuilt — so the webview may default to true and this
 * only ever reports a change.
 */
type VisibleMessage = { type: 'visible'; visible: boolean };

/**
 * One step as the editor posts it. `id` absent on a newly added row.
 *
 * `needs`, `lane`, `brand`, `model` and `effort` are whole values: a key the
 * draft leaves off is a key the step does not have. The host-only fields
 * (`check`, `output`, `retries`, …) are kept from the file — bar `uses`, which
 * the posted `prompt` replaces.
 */
type DraftStep = {
  id?: string;
  label: string;
  prompt: string;
  needs?: string[];
  lane?: string;
  brand?: BrandId;
  model?: string;
  effort?: string;
};

/** Create (`id` absent) or update (`id` present). */
type WorkflowDraft = {
  /** Absent on create; present on edit — immutable id / filename. */
  id?: string;
  label: string;
  /** Every named lane, in column order. Absent when no step names one. */
  lanes?: string[];
  steps: DraftStep[];
};

/** Host answer to `saveWorkflow`. */
type SaveWorkflowResultMessage =
  | { type: 'saveWorkflowResult'; ok: true; id: string }
  | { type: 'saveWorkflowResult'; ok: false; reasons: string[] };

/** Host answer to `deleteWorkflow`. */
type DeleteWorkflowResultMessage =
  | { type: 'deleteWorkflowResult'; ok: true }
  | { type: 'deleteWorkflowResult'; ok: false; reasons: string[] };

/**
 * What the run picker draws, answered when it opens rather than carried on the
 * state: occupancy is a bind test per port, and a three-second repaint has no
 * business making ten of them (`openRunPicker` — the same reasoning
 * `listConversations` is asked for on open).
 *
 * A port is `free: false` either because something is listening or because a
 * registry entry reserved it; `heldBy` is the branch when it is the second, and
 * the picker greys the row and names the holder either way.
 */
type PortsMessage = {
  type: 'ports';
  /** The row the sheet was opened on. Echoed back so a late answer can be
   *  matched to the sheet that asked, and never to the next one. */
  cwd: string;
  branch: string;
  runnerId: string;
  /**
   * A port is one of exactly three things, and the union says so rather than a
   * comment: free, held by something outside this panel, or held by a server of
   * ours — which is the only case with a name to print and something to stop.
   *
   * The third variant is what makes a held tile a way out rather than a dead
   * end: it carries a *Stop* for exactly the server holding it, keyed the way
   * `stopRun` is keyed. `heldBy` and `holder` arrive together because they are
   * read from one record, and a union is what stops the webview asking whether
   * this one has a name while that one has a way to stop it.
   *
   * The union of every start's `block`, each port once and in port order —
   * starts on one toolchain share a block, so rows per start would repeat it.
   * Each start draws the rows inside its own `block`.
   *
   * Besides every start's block, the rows include each start's remembered port
   * (`lastUsed[start.key]`), so the sheet can offer it back when it falls
   * outside that start's block (`sheetPorts`). Outside is per start, so no row
   * says so.
   */
  ports: (
    | { port: number; free: true }
    | { port: number; free: false }
    | {
        port: number;
        free: false;
        heldBy: string;
        holder: { cwd: string; runnerId: string };
      }
  )[];
  /**
   * Everything this tree can start: the root's own runners, then one entry per
   * workspace package that resolves to a runner (`core/devservers/workspaces.ts`).
   *
   * The sheet draws every start at once, each with its own port pick and its
   * own port row over the ports inside its `block`.
   */
  starts: RunStart[];
  /**
   * What each start used last on this branch, keyed by `key` below: the default
   * port belongs to the app, so each start's row reads its own entry, inside
   * its `block` or outside it (`ports` carries that row).
   *
   * A remembered port confers nothing (A17) — it is greyed out like any other if
   * something took it in the meantime.
   */
  lastUsed: { [key: string]: number };
};

/** One thing the run sheet can boot. */
type RunStart = {
  /** The directory it runs in — the tree itself, or a package below it. */
  cwd: string;
  runnerId: string;
  /** `<rel> · <runner label>`, or the runner's label alone for the tree root. */
  label: string;
  /**
   * How `lastUsed` is keyed, composed host-side so the webview never does path
   * arithmetic: the tree-relative directory and the runner id, or the bare
   * runner id at the root.
   */
  key: string;
  /** No port at all — the extension dev host. The sheet replaces the port field
   *  with a note rather than disabling it. */
  portless?: true;
  /** The port rides on `PORT` alone and may be ignored. Drawn as the menu row's
   *  sub, so the honesty is where the choice is made. */
  guessed?: true;
  /**
   * The ports this start is offered: the repo's hand-set block, else ten from
   * its toolchain's own port, else 3000–3009. Absent exactly when `portless`
   * (or from a host older than the field, whose start draws every row).
   */
  block?: { base: number; span: number };
};

/**
 * What the reader picked in the host's file dialog, answering one `pickFiles`.
 *
 * Paths and never bytes: a file the session is told about is one it reads for
 * itself, with its own tools and its own permission prompt — which is also why
 * nothing here has a size ceiling the way a pasted image does.
 *
 * `operationId` is the whole address. The dialog is modal to the host and not
 * to the panel, so the reader can select another card — or open a New — while
 * it stands, and the paths belong in the box that asked rather than in whatever
 * is up when they land. That box registered this id when it asked, and no pid
 * is needed to find it again: a **draft** has none, and a pid that has been
 * recycled meanwhile has a fresh record whose id set never held this one.
 */
type PickedFilesMessage = {
  type: 'pickedFiles';
  operationId: string;
  paths: string[];
};

/**
 * Host → webview progress for an account login sheet.
 * One sheet at a time; a new `startLogin` replaces any in flight.
 *
 * **The account login only.** An MCP login reports through `McpServerView` on
 * the state message instead — its row is the surface, so its progress belongs
 * with the rest of that row's state rather than on a channel of its own.
 */
type LoginProgressMessage = {
  type: 'loginProgress';
  brand: BrandId;
  /**
   * Absent means **no change** — the sheet keeps the step it is on. A `url`
   * push revises the door, not the step.
   *
   * Usually the step arrives anyway, in the same tick as the URL that precedes
   * it: `claude/auth.ts` `emitUrl`, `codex/auth.ts` after `account/login/start`,
   * `grok/auth.ts` on the first parse of its stdout. **Grok's second `url` is
   * the exception** — it re-sends the door to attach a `userCode` read off a
   * later line and sends no phase behind it (`grok/auth.ts`, the `else if` in
   * its reader). That push is the whole reason this is optional, so a reader
   * concluding the field is always present is about to delete a live branch.
   *
   * The host used to guess a value here from the brand name, which gave one
   * fact two authorities and the guess no source. Nothing replaces it: the
   * producer of the phase is the producer of the phase.
   */
  phase?: LoginPhase;
  /** Authorize URL when the CLI printed one. */
  url?: string;
  /**
   * Device-code wait. Presence paints the wait body (URL + code, no
   * input, no Submit). Absence keeps the paste body.
   */
  userCode?: string;
  message?: string;
};

/**
 * Host → webview result for an account sign-out sheet.
 * The confirm is local; this is the wait's answer after the reader confirms.
 * Login uses `loginProgress` instead — that one has real phases.
 */
type SignOutResultMessage = {
  type: 'signOutResult';
  brand: BrandId;
  phase: 'done' | 'error';
  message?: string;
};

type McpActionProgressMessage = {
  type: 'mcpActionProgress';
  operationId: string;
  phase: 'progress' | 'done' | 'error' | 'cancelled';
  mcp?: McpView;
  message?: string;
};

/** A host-authored confirmation. Action ids select offers, never targets. */
type ConfirmationView = {
  title: string;
  detail: string;
  actions: { id: string; label: string; destructive?: boolean }[];
};

type ConfirmModalMessage = ConfirmationView & {
  type: 'confirmModal';
  requestId: string;
};

type PanelMessage =
  | TicketDetailMessage
  | ConfirmModalMessage
  | McpActionProgressMessage
  | { type: 'warmChoice'; pid: number; startedAt: number; on?: boolean }
  /** What became of a `setRemote`. `on` is the value asked. `landed` is whether
   *  the view after the call agrees, so a late refusal drops only that flip. */
  | { type: 'remoteChoice'; on: boolean; landed: boolean }
  /** What became of a `setFlag`: the value it asked for, and whether the
   *  setting reads back as that. A write that threw, or one a narrower scope
   *  overrides, did not land and drops the reader's flip — only while the flip
   *  still holds `on`, so a refused earlier press leaves a later one. */
  | { type: 'flagChoice'; key: FlagKey; on: boolean; landed: boolean }
  /** What became of a `setWarmSetting`, the same way: `minutes` as posted. */
  | { type: 'warmSettingChoice'; key: string; minutes: number; landed: boolean }
  /** A `setTheme` that did not land. `theme` is the pick; the hold drops only
   *  while it is still that pick. Success is a state push naming it. Sent with
   *  `landed: false` only — a failed write, or a push for a folder this window
   *  no longer has open. */
  | { type: 'themeChoice'; theme: ThemeName; landed: boolean }
  /** A `setRemoteAllowlist` the host could not save, and why, worded.
   *  `account` is the newest added account the messenger refused, given back
   *  to an empty field to correct; the rest of that edit was saved. */
  | { type: 'remoteAllowlistFailed'; reason: string; account?: string }
  | ThreadMessage
  | ThreadPatchMessage
  | StateMessage
  | PortsMessage
  | PickedFilesMessage
  | SendResultMessage
  | RespondResultMessage
  | RevealMessage
  | OpenResultMessage
  | StartupStatusMessage
  | ResumeResultMessage
  | CloseResultMessage
  | ImageDataMessage
  | ConversationsMessage
  | SoundMessage
  | VisibleMessage
  | SaveWorkflowResultMessage
  | DeleteWorkflowResultMessage
  | LoginProgressMessage
  | SignOutResultMessage;

/**
 * An image pasted into the composer, still in the webview's hands. The host
 * writes it down at send time and sends its path — the only way the CLI takes
 * an image from a message. Nothing is written for a chip the user removes.
 */
interface ComposerImage {
  name: string;
  mediaType: string;
  /** `data:<mediaType>;base64,…`, straight off the paste. */
  dataUrl: string;
}

/** The running-session half of the model pick carried with one send. */
interface SendTarget {
  model?: string;
  window?: number;
  effort?: string;
}

type WarmHeldView = import('../core/warm').WarmHeld;

/**
 * One figure in Warm's configuration column, in whole minutes. `key` is what
 * `setWarmSetting` sends back to change it: opaque here, so the webview never
 * composes one, and checked against the host's own list when it returns.
 * `min` and `max` are the bounds the host clamps to.
 */
type WarmFigureView = {
  key: string;
  minutes: number;
  defaultMinutes: number;
  min: number;
  max: number;
};

/** Warm's configuration column: one cache lifetime per brand in Claude, Codex,
 *  Grok order, the ping buffer before each expiry, and the window after the
 *  last real turn that pings go on for. */
type WarmConfigView = {
  ttl: (WarmFigureView & {
    brand: BrandId;
    name: string;
    source: import('../core/cache_ttl').TtlSource;
    /** How far the default can be trusted. */
    tip: string;
  })[];
  buffer: WarmFigureView;
  window: WarmFigureView;
};

/**
 * One session's row in the nav bar's warm list: the host's decision, and the
 * times the webview words against its own clock. It never decides admission —
 * `held` is the reason, and a row with `nextAt` past is a ping being written.
 */
type WarmView = {
  /** The effective choice: the session's own, else the new-session default. */
  on: boolean;
  /** The cache lifetime the warmer plans against, and where it came from. */
  ttlMs: number;
  source: import('../core/cache_ttl').TtlSource;
  /** When the next keep-alive turn is written. Absent while held, off, or once
   *  no ping is left inside the window. */
  nextAt?: number;
  /** When keeping warm stops: the warm window after the last real turn. Only
   *  for a session that is on. */
  endsAt?: number;
  /** Set while on and not pinging, and on a session nothing here can ping
   *  (`unsupported`, which is also the one the host refuses a switch for). */
  held?: WarmHeldView;
};

/**
 * Remote as this window draws it: every word and affordance decided on the
 * host by `remoteStateView` (`ui/remote_view.ts`) from `RemoteHost.view()` and
 * the selected messenger's setup. No credential value, manifest text or URL is
 * on it.
 */
type RemoteStateView = {
  /** This window holds Remote, whatever the link's state. The switch's position. */
  on: boolean;
  /** Remote is on in some window, this one or another: what Keep-awake warns
   *  about. Off the link, never off `tone`, which a refusal turns to `fault`. */
  onSomewhere: boolean;
  /** The bar word's dot. `fault` is a failed link, or a turn-on just refused
   *  while the switch stays off; `elsewhere` is another window holding it. */
  tone: 'off' | 'pending' | 'live' | 'fault' | 'elsewhere';
  /** The one sentence: the bar word's tip, and the selected messenger's word
   *  unless `messengers.state` says Not configured. */
  status: string;
  /** Why the link is not up, or why Remote went off by itself; redacted by
   *  `core/remote/link.ts` and drawn verbatim. */
  reason?: string;
  /** The last turn-on that did not happen, naming the holder window when there
   *  is one. M0's or M2's sentence, drawn verbatim. */
  refused?: string;
  /** The holder window's folder, for the tip. */
  holderPath?: string;
  /** Things that may cost the reader a message, each with a press that fixes
   *  it where one exists. Only while `on`. */
  warnings: { text: string; fix?: 'keepAwake' | 'awakeRemote' }[];
  /** The standing quiet line while connected. */
  hint?: string;
  /** What setup lacks before a turn-on can work, in words; empty when ready.
   *  Non-empty disables the switch. */
  missing: string[];
  /** The messengers to pick from, which one this window runs, and the word
   *  its row wears. */
  messengers: { rows: RemoteMessengerRow[]; selected: string; state: RemoteMessengerState };
  /** The setup check of the selected messenger, decided on the host. */
  check: RemoteCheckView;
  setup: RemoteSetupView;
};

/** One messenger in the list. `live: false` is one not built yet: drawn,
 *  never pickable, with `tip` saying why. */
type RemoteMessengerRow = { id: string; label: string; live: boolean; tip?: string };

/** The selected messenger's word and dot: the link's, or `unset` while its
 *  setup is missing and nothing else would be said, with `tip` naming what. */
type RemoteMessengerState = {
  tone: RemoteStateView['tone'] | 'unset';
  text: string;
  tip?: string;
};

/** What the setup check found, in decided words and marks. */
type RemoteCheckView = {
  verdict: 'never' | 'checking' | 'ok' | 'setup' | 'unreachable';
  /** The verdict row's one sentence. */
  text: string;
  /** One per `setup.create.steps`, in order: what the check found of it. */
  marks: ('done' | 'failed' | 'todo')[];
  /** What an ok check was told, for the verdict's tip rows. Empty otherwise. */
  facts: { label: string; value: string }[];
  /** When the check this verdict reports finished (epoch ms), so its age is
   *  drawn as of each paint. Absent while none has. */
  at?: number;
};

/** The setup page's content: the adapter's own words, so nothing drawing it
 *  names a messenger. */
type RemoteSetupView = {
  /** The messenger's name as a reader knows it. */
  messenger: string;
  /** Whether each credential is stored, never its value, and where to find
   *  it. */
  fields: { key: string; label: string; set: boolean; help?: string }[];
  /** The allowed accounts, normalised. Not secrets: they sit in plain
   *  `settings.json` already. */
  allowlist: string[];
  /** Each listed account the messenger cannot use, with why, worded. Absent:
   *  every one is usable. */
  unusable?: { account: string; reason: string }[];
  /** How to find your own account, and what one looks like in its field. */
  sender: { help: string; placeholder?: string };
  /** The messenger's space, in its own word (a workspace), when its accounts
   *  have one: the value set, why it cannot be used, and a different one the
   *  last ok check found, to offer. */
  space?: {
    label: string;
    help: string;
    placeholder?: string;
    value?: string;
    problem?: string;
    found?: string;
  };
  /** Making the app. The blob and the URL stay on the host: `copyLabel` names
   *  the copy button, `link` says whether there is a page to open. `existing`
   *  is what an app made by hand must be set to. */
  create?: {
    steps: { title: string; text: string }[];
    existing?: { label: string; value: string }[];
    copyLabel?: string;
    link: boolean;
  };
};

/**
 * Settings the gear menu can flip. Names match the fields on `StateMessage`
 * (not the `squadron.*.enabled` configuration keys); the host maps one to
 * the other.
 */
type FlagKey =
  | 'orchestrators'
  | 'skipPermissions'
  | 'cafe'
  | 'cafeRemote'
  | 'cafeWarm'
  | 'devServers'
  | 'mascot'
  | 'executionCapture'
  | 'warmCache';

/** A move in the bottom drawer: the stated order, as far down as it reached. */
interface WorkflowOrderStatement {
  /**
   * Only what the reader has *moved*, and only ids the sheet drew. An id
   * naming a workflow that has since gone places nothing: forgetting is free
   * (`core/workflows/workflow_order.ts`).
   */
  order: string[];
}

/** Webview -> host. */
type WebviewMessage =
  /**
   * This half has just loaded and has nothing on screen.
   *
   * The host skips a state push whose board is identical to the last one it
   * sent (`TASK_done_panel_repaint_cost.md`), which is only sound while
   * "the last one it sent" is still what is drawn. A webview is a document, and
   * the host outlives it: dragging the tab to another editor group, `Developer:
   * Reload Webviews` and a renderer crash all rebuild it while `panel.ts` keeps
   * running with its comparison intact — so a fresh document would sit on the
   * empty skeleton until the state happened to change.
   *
   * Sent last in `main.ts`, once, after every handler is wired.
   */
  | { type: 'ready' }
  | { type: 'refreshSkills' }
  | { type: 'select'; pid: number; selection: string }
  | { type: 'threadSync'; pid: number; startedAt: number; selection: string }
  | {
      type: 'threadHistory';
      pid: number;
      startedAt: number;
      selection: string;
      generation: number;
      full: boolean;
    }
  | { type: 'seen'; pid: number }
  | { type: 'close'; pid: number; startedAt: number }
  | { type: 'confirmModalResult'; requestId: string; actionId?: string }
  /** End the running turn and leave the session at its prompt. Offered only
   *  while it is busy — an idle session has no turn to end, and ESC at a
   *  `waiting` one would cancel the dialog instead. */
  | { type: 'interrupt'; pid: number; startedAt: number }
  /**
   * A message for the session, and — when the composer had one mentioned — the
   * workflow it carries. `workflowId` absent is every send the panel has ever
   * made; present is "this message mentions that workflow", and the host is what
   * turns the mention into a line of prose (`enrich`), arms the run and starts
   * it. **`text` may be empty when a workflow is mentioned**: the mention alone
   * is a message, exactly as a pasted image alone is.
   *
   * This is the only workflow message there is, and the three absences are
   * decisions rather than gaps.
   *
   * No `runWorkflow`: applying a workflow is a mention on the next send (PRD
   * §14), so the send is what carries it, and a message removed from a composer
   * before Enter was never a run.
   *
   * No `armWorkflow`, and no `armed` on the state. Arming is a mode of the bar
   * and the host has nothing to do with a mode — it learns which workflow is
   * armed here, in the message that needs it. That also makes the mode's
   * lifetime right by construction: the panel keeps it while hidden
   * (`retainContextWhenHidden`) and forgets it on a reload, with nothing written
   * down to make it true.
   *
   * No `advanceRun`: panel-driven advance is rejected (PRD §15).
   *
   * `cancelWorkflow`: end the run a session is following. Not the mirror of the
   * send — the send arms a run the agent has not seen yet, this stops one it is
   * part-way through, so it is three acts and not an unlink (see the host
   * handler). Confirm is webview-side, on the chip, like `deleteWorkflow`'s, and
   * it is asked only of a run still working: a finished one has no work to stop,
   * and under exclusivity its × is on the way to every next workflow.
   *
   * `retryWorkflow`: Retry / Continue, the other answer to a paused run, and
   * the reason the × beside it is not the only one. It sends prose and nothing
   * else — the panel does not author progress (PRD §15), so the agent is asked
   * where the step stands, and the chip turns from grey to blue on the poll
   * that reads it moving. No `pid`-plus-step-id: the stopped step is whatever the
   * file says it is when the host reads it, and a step id on the wire would be
   * this window's guess at that going stale in flight.
   *
   * `saveWorkflow`: create (`id` absent) or update (`id` present). Host keeps
   * the file's host-only fields, replaces the rest, validates, writes. Result is `saveWorkflowResult`.
   *
   * `deleteWorkflow`: remove an existing file by id. Confirm is webview-side
   * (two clicks); host unlinks. Result is `deleteWorkflowResult`. Create
   * drafts have no Delete.
   *
   * `duplicateWorkflow`: copy a definition **host-side, file to file**, and not
   * by round-tripping a `WorkflowView`. The view carries id, label and per-step
   * prompt, and each step's lane, needs, model, effort and brand.
   * A duplicate is a *create*, so `saveWorkflow` would find no
   * `existing` to merge from and would drop `check`, `advance`,
   * `onFail`, `retries` and `description` — and a step whose body was `uses`
   * would come back as a `prompt`, so a duplicated `/implement` workflow would
   * stop resolving at arm time. Answered on `saveWorkflowResult`: a copy that
   * worked needs no message, since it arrives on the next poll like any other
   * file, and only a failure needs a word.
   *
   * `writeWorkflowOrder`: the whole order at once, not a delta on it, so the
   * host never has to read-modify-write on a drag. Last write wins with no
   * lock: two windows reordering in the same tick is one of them losing and
   * finding out on the next poll, which is `arrange.ts`'s bargain and the same
   * blast radius — one list.
   */
  | {
      type: 'send';
      pid: number;
      startedAt: number;
      operationId: string;
      text: string;
      images?: ComposerImage[];
      workflowId?: string;
      target?: SendTarget;
    }
  /**
   * Stop the workflow this session is following, whatever step it reached.
   *
   * Keyed by session incarnation and not by workflow id: one file per session
   * is the whole record, so there is never a second run to disambiguate from.
   * The host takes it only for a session it drives — the same rule the arming
   * send is refused under.
   */
  | { type: 'cancelWorkflow'; pid: number; startedAt: number }
  /**
   * Ask the session to have another go at the step its run failed on, and to
   * carry on through the rest.
   *
   * Keyed by the same incarnation as `cancelWorkflow`, and offered only where
   * a failed run is painted — a run that is still working has nothing to
   * retry, and a finished one has nothing left to fail.
   */
  | { type: 'retryWorkflow'; pid: number; startedAt: number }
  | ({ type: 'saveWorkflow' } & WorkflowDraft)
  | {
      type: 'deleteWorkflow';
      id: string;
    }
  | {
      type: 'duplicateWorkflow';
      id: string;
    }
  | ({ type: 'writeWorkflowOrder' } & WorkflowOrderStatement)
  /** Drop one held outbox entry. */
  | { type: 'dismissQueued'; pid: number; startedAt: number; id: string }
  /** Interrupt (if needed) and drain every held message. Confirm is webview-side. */
  | { type: 'sendNow'; pid: number; startedAt: number }
  /** One open request of an owned session, decided. Addressed by the CLI's own
   *  request id rather than by position, so a decision made on a card the CLI
   *  has since retracted lands nowhere instead of on whatever took its place. */
  | {
      type: 'respond';
      pid: number;
      startedAt: number;
      requestId: string;
      decision: RequestDecision;
    }
  /** Bytes for a ref a reader just opened. */
  | { type: 'image'; pid: number; id: string }
  /** Show the image in an editor tab, where a reader can save, copy or diff it.
   *  Also the only path for a ref too large to inline in the webview. */
  | { type: 'openImage'; pid: number; id: string }
  /** Open a file a turn wrote, however the host best shows that kind of file.
   *  Carries the path itself rather than a session and a ref: unlike an image,
   *  there is nothing to resolve out of the transcript — `files` is already the
   *  absolute path, and the turn it came from has no bearing on opening it.
   *  Optional line/column are 1-based and open source at that position. */
  | { type: 'openFile'; path: string; line?: number; column?: number }
  /** Diff a file a turn wrote, in the host's own diff editor.
   *  An exact sibling of `openFile`. `path` is absolute. `base`, when present,
   *  is that turn's baseline tree hash; omitted, the host opens against `HEAD`.
   *  It carries no cwd: `git show HEAD:<path>` resolves from the repo root
   *  rather than from a process's directory, so the before-image is asked for
   *  in the file's *own* directory (`git -C <dir> show HEAD:./<basename>`), which
   *  is right in a subdirectory and right in a linked worktree — where a repo
   *  root would name the tree the worktree was cut from, on another branch. */
  | { type: 'openDiff'; path: string; base?: string }
  /**
   * Ask the host for its file dialog, so a path can be written into the box.
   * The webview cannot name a file itself — a picker inside it hands back
   * bytes and a bare filename, and the session needs the path — so the one
   * surface that knows where a file is on this machine opens it.
   *
   * **Addressed by box, not by session.** `cwd` is where the dialog opens and
   * is all the host reads; the answer comes back on `operationId` alone. A
   * draft has no pid, and it asks for its own folder the same way a card asks
   * for `liveCwd ?? cwd` — one message, no fork on which kind of box it is.
   */
  | { type: 'pickFiles'; cwd: string; operationId: string }
  /**
   * Start a session in this directory.
   *
   * Posted at the **first send of a draft**, never at the press of New — the
   * draft lives in the webview until there is something to say, and this
   * message is what spawns. `brand`, `model` and `window` are the draft's own
   * pick and are what the start runs on. The gear's `model`/`contextWindow` is
   * where that pick *opens*, not what it is: the draft states its answer here
   * even when nobody touched the pill, so a start is never decided by a setting
   * read in a window the reader is not looking at.
   *
   * **The prompt is never here.** The draft's text stays in the webview: the
   * host answers with a `reveal` naming the same `draftId`, and the webview
   * then posts the ordinary `send` for that pid. `placeholder` is the
   * exception — its first line, to label the card until the CLI titles the
   * conversation. A label, never a name: see the field.
   *
   * `draftId` is local, opaque and short-lived. It is not a session id and
   * never becomes one: it names the surface waiting for this start, and dies
   * the moment the reveal is matched to it.
   */
  | {
      type: 'open';
      cwd: string;
      /** Absent means Claude — same default as `startOwned`. */
      brand?: BrandId;
      /** `''` is the account's own default, as a spawn already passes. */
      model?: string;
      /** The tokens of the picked row; absent names no window at all. */
      window?: number;
      /**
       * How hard the session is to think, in the selected brand's own
       * spelling. Absent sends no override at all and lets the CLI decide —
       * it is not a value, and no adapter is handed an invented one.
       *
       * Rides here for the reason `model` does: one place decides what a start
       * runs on, and it is the message. `squadron.efforts` is read into the
       * state push and seeds this, the way `squadron.model` seeds the pick —
       * `startOwned` reads no setting.
       */
      effort?: string;
      /** The draft's first line, to label the card until the CLI titles the
       *  conversation itself. Not a name: it never reaches `--name`, because a
       *  CLI files one of those the way it files a `/rename` and then titles
       *  nothing ever again (`core/naming.ts`). */
      placeholder?: string;
      draftId?: string;
    }
  | { type: 'startup'; attemptId: string; action: 'status' | 'cancel' }
  /** What has been talked about in this directory before, for the picker. Asked
   *  for when the picker opens rather than carried on the state: reading a
   *  directory of transcripts is not something a three-second repaint should do.
   *  No `cursor` ranks afresh; a cursor pages the snapshot it names. `query`
   *  filters that snapshot by title, host-side, so it reaches rows no page has
   *  loaded yet. */
  | {
      type: 'listConversations';
      requestId: string;
      cwd: string;
      cursor?: ConversationCursor;
      query?: string;
    }
  /** Start a session on a conversation that already exists. A start, not a
   *  revival — no pid, because no card is involved until the child is up.
   *  `name` is the row's own title, carried back because `--name` is read at
   *  start and never again; absent when the row's title was a prompt standing
   *  in for one. */
  | {
      type: 'resume';
      requestId: string;
      cwd: string;
      sessionId: string;
      /** Absent means Claude — same default as `startOwned`. The picker always sends it. */
      brand?: BrandId;
      /** A name somebody stated for this conversation, which is the only kind
       *  of title a picker row ever carries (`core/conversations.ts` reads the
       *  rest as a prompt standing in). Reaches `--name`; `placeholder` does not. */
      name?: string;
      /** The row's opening prompt, when that is all it had — so a resumed card
       *  reads like a fresh one instead of `agent-3f` until the CLI titles it. */
      placeholder?: string;
      /**
       * What this resume starts on, stated rather than left to the host.
       *
       * `''` is the account's own default. It rides here for the same reason it
       * rides on `open`: one place decides what a start runs on, and it is the
       * message. This picker has no model control of its own, so what it states
       * is the gear's setting, which is what a resume has always started on.
       */
      model?: string;
      /** The tokens of the picked row; absent names no window at all. */
      window?: number;
      /**
       * What this resume is to reason at, in the row's brand's own spelling.
       * Absent sends no override.
       *
       * Validated against the model beside it and dropped when that model is
       * dropped on a brand mismatch. A native value from one model is not
       * evidence that another brand's model accepts it.
       */
      effort?: string;
    }
  /** Put a reference to this session on the clipboard, for pasting into another
   *  session's prompt — `@squadron[pid][transcript]`, written by the host
   *  (`core/session_ref.ts`). */
  | { type: 'copyRef'; pid: number }
  /** Where the reader put this group's cards, as every top-level slot then on
   *  screen in the order then on screen — never a move to apply. A whole order
   *  is what makes two windows converge on one poll instead of replaying each
   *  other's gestures, and it is also what collects the entries whose sessions
   *  have since died. */
  | { type: 'arrange'; cwd: string; slots: number[] }
  /** Forget every arrangement on the machine and go back to the derived order.
   *  Board-wide: the derived order has no per-group half. */
  | { type: 'resetArrangement' }
  /** Set one board/agents flag to an absolute value. Desired state, not a flip,
   *  so a double-click cannot race the poll that echoes the write. */
  | { type: 'setFlag'; key: FlagKey; on: boolean }
  /** The reader dragged the cup. Offset from the board's bottom-left corner,
   *  posted once on release rather than through the drag — the webview has
   *  already moved the node, and this is only so it survives a reload. */
  | { type: 'moveCafe'; x: number; y: number }
  /**
   * What new sessions start on. `''` clears it back to the account's default.
   *
   * Unvalidated, both here and at the other end: a row picked from the flyout
   * and an id somebody typed are the same message, and a bad one is refused by
   * the CLI at the next start rather than by the panel now.
   *
   * `window` is the tokens of the picked row, absent for a typed id. It rides
   * beside `model` rather than inside it because `model` is what `--model`
   * takes verbatim, and the window is not part of any spelling the CLI has —
   * `[1m]` is composed at the launch seam.
   */
  | { type: 'setModel'; model: string; window?: number }
  /** What a new or resumed session on `model` starts at, in its native
   *  spelling. The gear offers only advertised values. */
  | { type: 'setEffort'; model: string; effort: string }
  /**
   * Name this session what the reader has just typed in the dock's head.
   *
   * **`title` is never empty**, matching the CLI's own rule
   * and refused again at the host: the CLI answers `title must be non-empty`,
   * and the bare `/rename` does something this repo has never identified.
   *
   * There is no result message, and that is deliberate. The name belongs to
   * `sessions/<pid>.json`, which the CLI rewrites and the next poll folds onto
   * the card — so the head goes on showing the old name for up to one poll and
   * then shows the real one, rather than painting an answer of its own that the
   * file might not agree with.
   */
  | { type: 'rename'; pid: number; startedAt: number; title: string }
  /** Keep one session's cache warm, or stop. Desired state, as `setFlag`;
   *  `startedAt` guards a reused pid as `rename` does. */
  | { type: 'setWarm'; pid: number; startedAt: number; on: boolean }
  /** Turn Remote on or off in this window. Desired state, as `setFlag`. */
  | { type: 'setRemote'; on: boolean }
  /** Ask for one credential. The host prompts in its own password box and
   *  stores it; the value never enters this document. */
  | { type: 'setRemoteField'; key: string }
  /** Delete every stored credential of the selected messenger. */
  | { type: 'forgetRemote' }
  /** Ask the selected messenger whether the stored credentials would
   *  connect. The verdict arrives on `RemoteStateView.check`; a press while
   *  one is running is ignored host-side. */
  | { type: 'checkRemote' }
  /** The allowed accounts as they should be after the edit: the whole list,
   *  desired state, as `writeWorkflowOrder` posts. The host saves what the
   *  messenger can use and refuses the rest (`remoteAllowlistFailed`). */
  | { type: 'setRemoteAllowlist'; ids: string[] }
  /** Set the messenger's space: `value`, or without one, ask in the host's
   *  own input box. A value the messenger refuses is not saved. */
  | { type: 'setRemoteSpace'; value?: string }
  /** Copy the app manifest to the clipboard, host-side. */
  | { type: 'copyRemoteSetup' }
  /** Open the messenger's create-the-app page, host-side. */
  | { type: 'openRemoteSetupLink' }
  /** One figure typed in Warm's configuration column, by the `key` its
   *  `WarmFigureView` was pushed with. The host clamps and rounds again, and
   *  writes nothing for a key it does not list. */
  | { type: 'setWarmSetting'; key: string; minutes: number }
  | { type: 'setTheme'; theme: ThemeName }
  | { type: 'setSound'; level: SoundLevel }
  | ({ type: 'connectTicketSource' } & TicketSelectionToken)
  /**
   * Whether the backlog is on screen: the tickets tab up *and* the dock open.
   * Gates nothing — an opening flip only asks the host to refresh now instead
   * of at the end of the current poll. Sent on the flip, never on a repaint.
   */
  | { type: 'ticketsOpen'; open: boolean }
  | ({ type: 'refreshTickets' } & TicketSelectionToken)
  /**
   * The sheet was opened, so it is worth asking the CLI what actually works.
   *
   * **Not on the poll.** `claude mcp list` is a network round trip per server;
   * the 30s refresh stays pure file reads, and this is the only thing that
   * justifies spending one. The answer arrives on the next state push.
   */
  | { type: 'refreshMcpHealth' }
  | ({ type: 'setTicketFilter'; filter: TicketFilterView } & TicketSelectionToken)
  | ({ type: 'selectTicketScope'; scopeId: string } & TicketSelectionToken)
  | ({ type: 'openTicket'; key: string } & TicketSelectionToken)
  | ({ type: 'readTicket'; key: string; requestId: string } & TicketSelectionToken)
  | { type: 'closeTicketDetail'; requestId: string }
  | { type: 'openTicketLink'; requestId: string; url: string }
  | { type: 'openTicketReference'; reference: string }
  /** Ask for a branch's occupancy, so its picker can open. Answered with
   *  `ports`; the bind test happens here and never on the poll. */
  /** Ask for what a row's sheet needs. `cwd` is the row's own directory — which
   *  in a monorepo is a package — and `tree` is the worktree it belongs to.
   *  Both, because the list of starts and the remembered ports are the tree's,
   *  while the entry to preselect and the port to exclude are the row's. */
  | { type: 'openRunPicker'; cwd: string; tree: string; branch: string; runnerId?: string }
  /** Start a server, on the port the user picked. No request kind behind this
   *  one: starting has no ownership constraint, so it is always local.
   *
   *  `cwd` is what runs — a package below the tree in a monorepo — and `tree` is
   *  the worktree the sheet was opened on. Both, because the remembered port is
   *  keyed by one relative to the other, and only the sheet knows the pair. */
  | { type: 'run'; cwd: string; tree: string; runnerId: string; branch: string; port?: number }
  /** Stop one, wherever it is running — the window holding the terminal is the
   *  only one that can dispose it, so this crosses as a request when it is not
   *  this window's. */
  | { type: 'stopRun'; cwd: string; runnerId: string }
  /** End a listener an owned session is running — the ✕ on its chip. There is
   *  no terminal to dispose, so this is a signal to the pid, and `startedAt` and
   *  `command` travel with it as the check: the reading behind that chip is up
   *  to a poll old, and a recycled pid is some other process by now. */
  | { type: 'killListener'; port: number; pid: number; startedAt: number; command: string }
  /** Open a running server's URL, in whatever the host opens a URL with. */
  | { type: 'openServer'; url: string }
  /** Start Claude (or later another brand's) login flow. */
  | { type: 'startLogin'; brand: BrandId }
  /** Open this brand's install page. The host holds the URL, so none crosses
   *  the wire. */
  | { type: 'installCli'; brand: BrandId }
  /** Open the settings box for this brand's binary path. */
  | { type: 'setCliPath'; brand: BrandId }
  /** The reader finished or dismissed onboarding. */
  | { type: 'onboardingDone' }
  /** Open a named page; the host supplies the URL. */
  | { type: 'openExtensionPage'; page: 'marketplace' | 'openvsx' | 'survey' | 'issue' }
  /** Re-ask every CLI now, whatever its stored sign-in says. */
  | { type: 'recheckClis' }
  /** Cancel an in-flight login child. */
  | { type: 'cancelLogin' }
  /** Paste-code: authorization code from the browser. */
  | { type: 'submitLoginCode'; code: string }
  /**
   * Open the authorize URL via the host's openExternal (IDE trust dialog).
   * The reader-initiated path from the sheet — the host already opens the same
   * URL on login for every brand whose CLI opens no tab of its own
   * (`CliAdapter.loginOpensBrowser`), so this is the second chance rather than
   * the only one.
   */
  | { type: 'openLoginUrl'; url: string }
  /** Confirmed sign-out for one brand. */
  | { type: 'confirmSignOut'; brand: BrandId }
  /**
   * Authorise one MCP server for one brand. The host picks how — a pty child
   * from a repo that declares the name, or a trigger on a live session (or a
   * disposable one).
   */
  | {
      type: 'startMcpLogin';
      name: string;
      brand: BrandId;
      root?: string;
      target?: McpActionRef;
      operationId?: string;
    }
  /** Cancel the in-flight MCP login child. */
  | { type: 'cancelMcpLogin'; operationId?: string }
  /**
   * Clear that brand's stored credentials for one MCP server. Confirmed in the
   * cell itself rather than behind a sheet — Authorise is one press away in the
   * same cell, so this is cheap to undo.
   */
  | {
      type: 'mcpLogout';
      name: string;
      brand: BrandId;
      root?: string;
      target?: McpActionRef;
      operationId?: string;
    };

/** Survives the panel being hidden; nothing here is worth losing sleep over. */
type PanelState = { dockWidth?: number };

interface WebviewApi {
  postMessage(message: WebviewMessage): void;
  getState(): PanelState | undefined;
  setState(state: PanelState): void;
}

declare function acquireVsCodeApi(): WebviewApi;

/** The icons the webview draws, as SVG markup — its script cannot import them. */
type WebviewIcons = {
  terminal: string;
  flame: string;
  stop: string;
  interrupt: string;
  plus: string;
  clock: string;
  link: string;
  refresh: string;
  arrowLeftToLine: string;
  keyRound: string;
  settings: string;
  x: string;
  info: string;
};

/** Injected by `panel.ts` in a script ahead of this one. */
declare const ICONS: WebviewIcons;
