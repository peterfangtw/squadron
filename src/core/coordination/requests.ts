import type * as origin from './origin';
import * as requestCodec from './request_codec';
import { randomUUID } from 'crypto';
import * as incoming from '../incoming';
import type {
  FetchFileIdentity,
  FetchFileReply,
  HostIdentity,
  IncomingAccess,
  IncomingDelivery,
  IncomingDenied,
  IncomingEvidence,
  IncomingEvidenceQuery,
  IncomingRefusal,
  LaunchAttempt,
  RemoteLaunchEvidence
} from '../bridge/model';
import * as fs from 'fs/promises';
import * as path from 'path';
import { readJson } from '../files';
import type { MessageFact } from '../message_facts';
import type { BrandId, ImageBlock, SendTarget } from '../model';
import type { ModelListing } from '../model_listing';
import { REQUESTS_DIR } from '../paths';

/**
 * Unclaimed this long and the window it was addressed to is not coming.
 *
 * Exported because `awaitReplyDetailed`'s verdict depends on it: past this any
 * window sweeps an unclaimed request, so a deadline beyond it would read
 * "swept" as "a handler claimed it". A caller that waits longer than this must
 * not trust `claimed` — `cli/spawn.ts` waits 20 s and reads only whether a
 * reply came.
 */
export const STALE_MS = 10_000;

/**
 * The longest a caller may wait on `awaitReplyDetailed` and still trust its
 * `claimed`.
 *
 * The margin under `STALE_MS` is the whole of it: at the deadline the request
 * file's presence is the verdict, and past `STALE_MS` any window may have
 * swept it — so a longer wait reads "swept" as "a handler took it" and falls
 * back onto work already in flight. **This is not a budget for how long the
 * other window's handler takes**; that is what `graceMs` is for, and it may run
 * well past this because by then `claimed` has already been decided.
 *
 * **The margin is hand-picked; the subtraction only says which way it leans.**
 * What actually has to hold is the round trip — post, poll hops, the read at
 * each — landing inside `STALE_MS`, and none of those terms is here. Two
 * seconds is room for the drift of eighty `setTimeout(100)` hops, measured
 * against nothing. Written as a subtraction so that moving `STALE_MS` moves
 * this too, which is the half of the relation a constant can carry. Floored, so
 * shrinking `STALE_MS` below the margin cannot produce a deadline in the past
 * and a loop that never reads.
 *
 * Here rather than in either caller because it is a property of the protocol,
 * not of what is being started: `host/runs.ts` and `host/session_open.ts` had
 * the same expression written down twice with two different rationales beside
 * it, and only one of them named the constraint that actually sizes it. What
 * stays at a caller is how long *its* handler takes, which is the other half
 * and genuinely differs.
 *
 * A caller that does *not* read `claimed` is not bound by this and should not
 * import it — `cli/spawn.ts` waits 20 s on the same `open`, deliberately past
 * `STALE_MS`, because it asks only whether a reply came.
 *
 * **No caller in `src/` reads `claimed` today.** Both did until row 71: the
 * routed dev-server start and the routed resume, each of which fell back to
 * doing the work itself and so had to tell a refusal from silence. Kept rather
 * than deleted with them, because what it states is a property of the request
 * protocol and not of either caller — the next shim that falls back needs this
 * exact deadline, and rediscovering the `STALE_MS` relation is how the two
 * callers came to write it down twice with two different rationales.
 */
export const CLAIMED_REPLY_MS = Math.max(1_000, STALE_MS - 2_000);

/**
 * Starts outlast the transport's 3000 ms default. The window claims the
 * request on a 500 ms poll (`host/extension.ts`), hands it to `startOwned`,
 * and only writes the reply once that returns — and starting a CLI child is
 * measured at ~3 s in this repo (`src/test/AGENTS.md`). So a spawn that worked
 * was landing on exit 4, whose advice is to report it and retry: a second
 * session for one prompt.
 *
 * 20 s rather than more: a request nobody claims is binned at 10 s
 * (`STALE_MS`), so past that only a slow start is still coming, and this
 * leaves ~6x the measured start for one.
 */
const OPEN_REPLY_MS = 20_000;

// Required for every kind, so a new slow operation cannot inherit the transport's 3 s wait.
export const REPLY_MS: Readonly<Record<RequestBody['kind'], number>> = {
  open: OPEN_REPLY_MS,
  models: OPEN_REPLY_MS,
  remoteStartFilesV1: OPEN_REPLY_MS,
  incomingEvidenceV1: 3_000,
  fetchFile: 60_000,
  send: 3_000,
  answer: 3_000,
  rename: 3_000,
  warm: 3_000,
  close: 3_000,
  interrupt: 3_000,
  deny: 3_000,
  personAnswer: 3_000,
  /**
   * A file at the 10 MiB cap over an uplink of at least 2 Mbit/s takes about
   * 42 s, plus messenger calls. The messenger's upload deadline stays below
   * this so the caller hears the outcome. Past STALE_MS deliberately: uploads
   * read only whether a reply came, never the claimed verdict.
   */
  attach: 60_000
};

/** The refusal for a request file whose fields are not its kind's. */
export const MALFORMED = 'That request could not be read.';

const REQUEST_SUFFIX = '.request.json';
const REPLY_SUFFIX = '.reply.json';
const CLAIM_SUFFIX = `${REQUEST_SUFFIX}.claim`;

export type RemoteStartFilesV1 = {
  kind: 'remoteStartFilesV1';
  version: 1;
  windowId: string;
  expectedHost: HostIdentity;
  attempt: LaunchAttempt;
  localRoot: string;
  prompt: string;
};
export type IncomingEvidenceV1 = {
  kind: 'incomingEvidenceV1';
  version: 1;
  windowId: string;
  expectedHost: HostIdentity;
  challenge: string;
  query:
    | IncomingEvidenceQuery
    | Readonly<{ kind: 'holder'; holder: import('../bridge/model').IncomingHolder }>;
};
export type FetchFile = FetchFileIdentity & { kind: 'fetchFile'; version: 1; windowId: string };

/** New action posters state origin and retain legacy markers for older readers. */
export type RequestBody = RequestFields & { origin?: origin.RequestOrigin };

/**
 * Which window the session verbs name. `open` and `models` use the
 * spawn-selected window; `send`, `answer`, `rename`, `close`, `interrupt`,
 * `deny` and `personAnswer` use the window holding the target session's pipe;
 * `attach` uses the Remote holder's. Model discovery needs no target session
 * or open panel.
 */
type RequestFields =
  | RemoteStartFilesV1
  | IncomingEvidenceV1
  | FetchFile
  | { kind: 'models'; windowId: string }
  // `prompt` is the session's first turn, handed to the CLI the addressed
  // window starts. Optional, so the panel's own button still posts a bare open,
  // and an in-flight request from an older panel stays valid.
  // `ticketRef` rides along for the same reason `parentSessionId` does: the spawn
  // is the only moment the ticket and the session it became are both in hand.
  // `name` likewise, and more so: `--name` is read at start and never again, so
  // a name that misses this request is a name the session can never be given.
  // Optional, and derived from the prompt when absent, so an older shim's
  // request still starts a session that has one.
  // `resume` makes the same open carry on a conversation that already exists
  // instead of beginning one, which is why it is a field here and not a kind of
  // its own: everything else about the start — the window that must own it, the
  // directory, the terminal that never gets made — is identical, and a second
  // kind would be the same handler twice.
  | {
      kind: 'open';
      windowId: string;
      cwd: string;
      prompt?: string;
      correlation?: string;
      name?: string;
      parentSessionId?: string;
      // Which fan-out the new session belongs to, beside `parentSessionId` and
      // for the same reason: the spawn is the only moment either fact exists.
      // The shim inherits it from its own environment, so a chain of spawns all
      // name the session the fan-out opened at rather than each other.
      originSessionId?: string;
      // The session that wrote `prompt`, as `send`'s `from`: the window wraps
      // the first turn in the same envelope, so the child's dock draws a peer.
      // Not `parentSessionId`, which `--parent-session-id` re-points elsewhere.
      from?: string;
      ticketRef?: string;
      // A workflow to put the new session on, by id; the starting window arms
      // it, against the cwd the session will stand in. Needs a `prompt` — the
      // briefing rides the turn that prompt becomes.
      workflowId?: string;
      // A transcript to carry on rather than a session to begin. **No poster in
      // `src/` since row 71**, which took the panel's cross-window resume; kept
      // and still served for `effort`'s reason below — an older window's panel
      // can post one at a newer window, and the two do not reload together.
      resume?: string;
      /** Which CLI to start. Absent with no `model` means inherit the
       *  parent's brand at the window — an unbranded spawn inherits a parent
       *  rather than a machine-wide default, and there is no longer one to
       *  inherit. */
      brand?: string;
      /** What `--model` should be. Needs `brand`. Absent with no `brand`
       *  inherits the parent's pick; absent with `brand` is the account
       *  default. */
      model?: string;
      /** The window beside `model`, in tokens. An older window ignores the
       *  field and starts with none, exactly as it does with `model`. */
      window?: number;
      /**
       * How hard the started session is to think, in the brand's own spelling.
       *
       * **Flat, like the three above it, and deliberately not one nested
       * target.** In memory these four travel as a `LaunchTarget`
       * (`core/model.ts`), and this is the one boundary where that value is
       * taken apart. A nested field would make an older window — which reads
       * this file with a cast and no version decoder — ignore the *whole*
       * selection and fall back to its own inheritance and its own global
       * effort, rather than ignoring one field it does not know.
       *
       * So the skew is one-field-wide in both directions: an older reader
       * ignores this and keeps reading `squadron.effort` at launch, and a
       * newer reader treats an older request's absence as no override.
       *
       * `squadron-spawn --effort` writes it, as stated; the window checks it
       * against the child's model and fills the model's default when absent
       * (`effortOf`, `core/coordination/spawn.ts`). A bare open never carries
       * one since row 71 — its one poster was the panel's cross-window resume —
       * and the arm that reads it there (`host/request_host.ts`) stays because
       * windows on this machine do not reload together, so a panel of an older
       * build is still able to post one at a newer window.
       */
      effort?: string;
      selection?: 'catalog' | 'default';
      /**
       * A person's start from the Remote host (D25), like the panel's `+`: no
       * spawn gate, no lineage, not in the Fleet. Served only while `remote`
       * names the live holder (`serve_owned.ts`), which is not a security
       * boundary (`core/remote/holder.ts`). The start is the window's default
       * pick, or `brand` alone on its account default.
       *
       * **An older window ignores both and serves this as an agent spawn:**
       * gated by `orchestrators.enabled`, written to lineage, counted. That is
       * a refusal with a reason or a session that counts toward a cap, and
       * never a break.
       */
      via?: 'remote';
      /** The Remote holder's `windowId` this was sent on behalf of. */
      remote?: string;
    }
  // `images` ride inline as content blocks, the same ones the local owned path
  // already builds off the paste. Not paths: the addressed window drives this
  // session over a pipe, which takes the bytes themselves, so writing a file
  // here would be one the reading window has no reason to want.
  // Legacy `via: 'verb'` selects agent admission; `from` never does. A body
  // with `from` and no `via` remains composer-compatible. Explicit origin must
  // agree with these markers; coordination/origin.ts owns that contract.
  // `interrupt` makes the message the next instruction rather than the one after
  // the turn in flight; it is a field here and not a kind because the interrupt
  // and the message have to land as one act.
  | {
      kind: 'send';
      incomingDelivery?: IncomingDelivery | IncomingDenied;
      incomingHolder?: import('../bridge/model').IncomingHolder;
      windowId: string;
      pid: number;
      startedAt: number;
      text: string;
      correlation?: string;
      images?: ImageBlock[];
      /** Travels with the message because a busy session may hold both. */
      target?: SendTarget;
      via?: 'verb';
      /** Claimed holder for a new explicit Remote send; checked independently. */
      remote?: string;
      from?: string;
      /**
       * The sending session's own pid, resolved by the shim off the board it
       * was already holding to find the target.
       *
       * **Here so the window need not build a board to learn it.** A wait names
       * its members by pid — the address every verb takes — and this arrives
       * naming a sessionId, so holding a report against an open wait means
       * joining the two. Doing that in the window costs a process scan on every
       * peer send; doing it in the shim costs nothing, because `sendPlan` has
       * already loaded the board.
       *
       * **Absent is common and always safe.** An older shim, a caller on no row
       * of the board, and a sessionId naming two resumed sessions all arrive
       * that way, and all of them mean the send behaves exactly as it did
       * before any of this existed. Nothing is ever refused for want of it.
       */
      fromPid?: number;
      interrupt?: boolean;
      // Travels, because the window runs `checkSend` too: a `--force` the shim
      // acted on and did not pass would be refused there. It lifts the stale
      // and context guards only.
      force?: boolean;
    }
  // Answer a session's open question, from another session: the window checks
  // `askId` is still an open question, then delivers `text` as `send
  // --interrupt` would — the interrupt withdraws the question, and the answer
  // arrives as the next prompt. `text` is the shim's prose, already wrapped.
  // `askId` because `id` is the envelope's. `squadron-answer` is the poster.
  // A kind of its own, never a `send` with an `askId`: an older window would
  // deliver that as a plain interrupt, with no question checked at all.
  | {
      kind: 'answer';
      windowId: string;
      pid: number;
      startedAt: number;
      askId: string;
      text: string;
      correlation?: string;
      from?: string;
      force?: boolean;
    }
  // Rename a running session. On the list because it goes on a pipe, and only
  // the window holding that pipe can write to it — and `title` is never empty,
  // since the owning window refuses a blank rather than sending one the CLI
  // would answer `title must be non-empty` to. `squadron-rename` is the
  // poster.
  | { kind: 'rename'; windowId: string; pid: number; startedAt: number; title: string }
  // Set a running session's Warm choice, as the Warm sheet's switch does. On
  // the list for rename's reason: the choice lives in the registry of the
  // window holding the pipe. `squadron-warm` is the poster.
  | { kind: 'warm'; windowId: string; pid: number; startedAt: number; on: boolean }
  // The other end of `open`: a session the addressed window started as a child
  // of its own extension host is ended by that window closing the pipe, which is
  // the only thing that also takes the card off its board. A signal from here
  // reaches the process and nothing else — that window keeps a registry entry
  // for a session it will read as having died on its own.
  | { kind: 'close'; windowId: string; pid: number; startedAt: number }
  // The Remote host's three kinds (M2), each served only while `remote` names
  // the live holder window (not a security boundary: `core/remote/holder.ts`).
  // An older window answers each with the "older Squadron" refusal, as it does
  // any kind it has no case for.
  //
  // `interrupt`: Stop, the turn in flight ended.
  | { kind: 'interrupt'; windowId: string; pid: number; startedAt: number; remote: string }
  // `deny`: refuse one open request. **No decision rides here**: the serving
  // window builds `{ allow: false }` itself, so no shape of this request can
  // grant a permission (D18). `reason` is dropped where the CLI's response
  // cannot carry one.
  | {
      kind: 'deny';
      windowId: string;
      pid: number;
      startedAt: number;
      requestId: string;
      reason?: string;
      remote: string;
    }
  // `personAnswer`: a person's typed answer to an open question, delivered as
  // the next prompt with the question withdrawn — or, if it has closed, as an
  // ordinary message, since the person's words are never dropped. A kind of its
  // own and not a `send` with an `askId`, for `answer`'s reason above.
  | {
      kind: 'personAnswer';
      incomingDelivery?: IncomingDelivery | IncomingDenied;
      incomingHolder?: import('../bridge/model').IncomingHolder;
      windowId: string;
      pid: number;
      startedAt: number;
      askId: string;
      text: string;
      correlation?: string;
      remote: string;
    }
  // `attach`: an agent's file into its own conversation at the messenger
  // (`squadron-attach`). **The one kind addressed to the Remote holder**:
  // `windowId` is the holder's, read by the shim from `holder.json`, because
  // `claimRequests` routes on that field and the holder is the process that
  // reads the file and posts it. The session's own window is
  // `sessionWindowId`, half of the address the holder looks the session up
  // by, and is never asked: the session's pipe is not involved.
  //
  // `path` is a hint, never trusted: the holder re-resolves it against the
  // session's cwd and checks it again (`core/remote/attach.ts`), because a raw
  // request file reaches the holder without the shim. `from` is the sender's
  // session id, which the holder holds to the session at `pid`; the rate cap
  // counts that session by pid and start, never `from`.
  //
  // An older holder has no arm for this and answers "This window does not
  // drive that session." — the pid lookup every unknown pid-carrying kind
  // falls to — rather than "older Squadron", which only a window holding the
  // session can say.
  | {
      kind: 'attach';
      windowId: string;
      pid: number;
      startedAt: number;
      sessionWindowId: string;
      path: string;
      caption?: string;
      from: string;
    };

/**
 * The envelope. `id` and `createdAt` are written by `postRequest` *over* the
 * body, so no `RequestBody` variant may carry a field of either name — one that
 * did would be silently replaced on the wire, and typed as `string` on both
 * sides it would compile.
 */
export type Request = RequestBody & { id: string; createdAt: number };

type EnvelopeField = 'id' | 'createdAt';

/** A bare `keyof RequestBody` covers only shared fields and cannot detect a variant's clash. */
type BodyField = RequestBody extends infer V ? (V extends object ? keyof V : never) : never;

type Clash = Extract<BodyField, EnvelopeField>;
export type NoEnvelopeClash<T extends never = Clash> = T;

/**
 * What the addressed window made of a request.
 *
 * `queued` is how many messages that window is holding for the session after
 * handling a `send` — 0 being an outbox the send drained, and so a message
 * actually on the pipe. `ok` alone cannot say that: a send is accepted whether
 * the session is idle, busy or waiting, so the asking window would otherwise
 * have to guess, and a run recorded as `running` for a message still sitting in
 * somebody else's outbox is stuck. Absent is a window built before this said
 * anything, and reads as "cannot say".
 *
 * `pid` is set when an `open` (or resume-shaped open) actually started a
 * session — `startOwned` already returns it. The asking panel needs that
 * number to `reveal` what the reader asked for in *their* window, so arm and
 * dock selection follow the initiator, not only the window that holds the pipe.
 */
export type Reply = {
  startupVersion?: 1;
  attemptId?: string;
  /** Close execution failures are retryable; an ordinary negative reply is a refusal. */
  closeFailure?: 'unavailable' | 'failed' | 'gone';
  sessionId?: string;
  incomingAccess?: IncomingAccess;
  remoteLaunchEvidence?: RemoteLaunchEvidence;
  incomingDelivery?: import('../bridge/model').IncomingDeliveryEvidence;
  incomingEvidence?: IncomingEvidence;
  incomingHolderEvidence?: Readonly<{
    challenge: string;
    holder: import('../bridge/model').IncomingHolder;
  }>;
  fetchFile?: FetchFileReply;
  incomingRefusal?: IncomingRefusal;
  ok: boolean;
  messageFacts?: readonly MessageFact[];
  models?: ModelListing;
  remoteSelection?: { defaultTarget: import('../model').LaunchTarget };
  notStarted?: true;
  selectionInvalid?: true;
  reason?: string;
  queued?: number;
  pid?: number;
  /** Process incarnation paired with `pid`, when the serving window knows it. */
  startedAt?: number;
  /** The brand an `open` from Remote started, as the serving window resolved
   *  its default pick. Absent is a window built before this field. */
  brand?: BrandId;
  /**
   * The pid of the requester whose open wait this message is being held for.
   *
   * Set only when the window parked a report rather than putting it on the
   * pipe, and it is what lets the shim tell the sender the truth instead of
   * `(held, N in the outbox)` — which would be false twice over, since the
   * outbox has not grown and the message is not waiting on an idle edge.
   *
   * Absent is a window that parks nothing, or one built before this existed,
   * and reads as "not held for anything" — the same back-compat shape `queued`
   * above already has. `queued` is still sent beside it and is still true: a
   * park enqueues nothing, so the depth is whatever it already was.
   */
  heldForWait?: number;
  /**
   * Set when this refusal is the brand, model or effort. A lane may fall back
   * from that and from nothing else. Absent is every other refusal, and a
   * window built before this field existed — both read as not a pick.
   */
  cause?: 'pick' | 'startup' | 'timeout' | 'cancelled';
  /**
   * Set on an `interrupt` the serving window found no turn running for: Stop
   * settles "Nothing to stop". Absent is an interrupt sent, and a window
   * built before this field, which interrupted whatever it held.
   */
  idle?: true;
  /**
   * The operation may have landed; replay could send a message, start a
   * session or post an attachment twice. Shims report exit 4, never 2.
   */
  unsure?: true;
};

/** Files reuse the claim directory. Requests surviving a crash are swept. */
export async function postRequest(request: RequestBody): Promise<string | undefined> {
  const id = randomUUID();
  const delivery = 'incomingDelivery' in request ? requestCodec.deliveryOf(request) : undefined;
  const scoped =
    requestCodec.incomingKind(request.kind) || (delivery !== undefined && !('denied' in delivery));
  const file = path.join(REQUESTS_DIR, `${scoped ? 'incoming-' : ''}${id}${REQUEST_SUFFIX}`);
  try {
    const body = JSON.stringify({ ...request, id, createdAt: Date.now() });
    if (scoped && Buffer.byteLength(body, 'utf8') > incoming.INCOMING_MAX_BYTES) return undefined;
    await fs.mkdir(REQUESTS_DIR, { recursive: true });
    await fs.writeFile(file, body);
    return file;
  } catch {
    return undefined;
  }
}

/** Lineage records this id before the child exists. Find a timed-out spawn without retrying it. */
export function requestIdOf(file: string): string {
  return path.basename(file, REQUEST_SUFFIX).replace(/^incoming-/, '');
}

/**
 * The addressed window's answer, or undefined when it never came — a window
 * that died since publishing its claim must not swallow the click, so callers
 * fall back rather than wait on it.
 */
export async function awaitReply(file: string, timeoutMs = 3000): Promise<Reply | undefined> {
  return (await awaitReplyDetailed(file, timeoutMs)).reply;
}

/**
 * `awaitReply`, plus whether anyone ever came for the request.
 *
 * Silence is two different answers and every caller before this one had to
 * treat them as one. `claimRequests` claims a request by removing its file and
 * only *then* runs the handler, so at the deadline `take` is the question.
 * `STALE_MS` is 10s and nothing else removes an unclaimed request, so any
 * deadline shorter than that reads cleanly.
 *
 * What it is for: a caller that falls back to doing the work itself. Falling
 * back on a slow handler does the work twice, and for a dev server that is two
 * terminals in two windows under one record — the second unnameable, and so
 * unstoppable from any panel. Falling back on a request nobody claimed is free.
 */
export async function awaitReplyDetailed(
  file: string,
  timeoutMs = 3000,
  graceMs = 0
): Promise<{ reply?: Reply; claimed: boolean; invalid?: true }> {
  const reply = file.replace(REQUEST_SUFFIX, REPLY_SUFFIX);
  const deadline = Date.now() + timeoutMs;
  let invalid = false;
  const read = async (): Promise<Reply | undefined> => {
    try {
      const raw = await requestJson(reply);
      if (raw === undefined) return undefined;
      if (!isRecord(raw) || typeof raw.ok !== 'boolean') {
        invalid = path.basename(file).startsWith('incoming-');
        return undefined;
      }
      const body = requestCodec.readReply(raw);
      if (!body) {
        invalid = path.basename(file).startsWith('incoming-');
        return undefined;
      }
      await fs.rm(reply, { force: true });
      if (body.fetchFile && body.fetchFile.requestId !== requestIdOf(file))
        return {
          ok: false,
          incomingRefusal: 'evidence-unavailable',
          reason: 'Incoming file evidence could not be read.'
        };
      if (
        path.basename(file).startsWith('incoming-') &&
        body.ok &&
        !body.fetchFile &&
        !body.incomingEvidence &&
        !body.incomingHolderEvidence &&
        !body.remoteLaunchEvidence &&
        !body.incomingDelivery
      )
        return {
          ok: false,
          incomingRefusal: 'unsupported-capability',
          reason: 'Incoming file access is unavailable in this build.'
        };
      return body;
    } catch {
      return undefined; // not answered yet, or half-written
    }
  };

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const body = await read();
    if (invalid) {
      await take(file);
      await fs.rm(reply, { force: true });
      return { claimed: true, invalid: true };
    }
    if (body) {
      return { reply: body, claimed: true };
    }
  }

  // **The removal is the question, not a stat before it.** A stat says whether
  // the file was there a moment ago, and a handler claiming it in that moment
  // gave two windows the same answer — the asking one starting a second dev
  // server on top of the one already being started. `take` is atomic against
  // the `take` in `claimRequests`, so exactly one of the two wins it: taking
  // the file here means nobody handled the request and nobody now can.
  // `false` from `take` means this caller did not remove the file.
  const claimed = !(await take(file));
  if (!claimed) {
    // We took the request, so no answer is coming and none can be written now.
    await fs.rm(reply, { force: true });
    return { claimed };
  }

  // Grace preserves a slow handler's refusal instead of treating silence as
  // acceptance. Default off: callers treating refusal and silence alike gain nothing.
  const grace = Date.now() + graceMs;
  while (Date.now() < grace) {
    const late = await read();
    if (late) {
      return { reply: late, claimed: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The window claimed it and never answered — it died mid-handle, or is wedged.
  await fs.rm(reply, { force: true });
  return { claimed };
}

/**
 * Removes `file`, and says whether this caller is the one that removed it.
 *
 * The claim is an exclusive create of `${file}.claim` (`wx`). Two overlapping
 * renames of one file both succeed on Windows: the second follows the open
 * handle onto the new name, 1,000 of 1,000 on 2026-10-10, and `claimRequests`
 * then handled one request twice in 165 of 300 runs with the cores busy (0 of
 * 300 idle). `wx` had one winner in 1,000 of 1,000 on that machine. `unlink`
 * is not a claim either — on macOS 15.6 APFS it returned 0 to both of two
 * threads 289 of 300 times (2026-09-28). A marker this caller did not create
 * stays: its age cannot prove that its taker died. The request expires before
 * its abandoned marker is swept, so cleanup cannot replay a paused taker.
 */
async function take(file: string): Promise<boolean> {
  const claim = `${file}.claim`;
  try {
    await fs.writeFile(claim, '', { flag: 'wx' });
  } catch {
    return false;
  }
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(claim, { force: true }).catch(() => undefined);
  }
}

/** A claim may be abandoned only after its request is gone: age alone cannot
 *  distinguish a dead taker from a paused syscall. Request IDs are never reused. */
async function sweepStaleClaims(names: readonly string[]): Promise<void> {
  const present = new Set(names);
  await Promise.all(
    names.map(async (name) => {
      if (!name.endsWith(CLAIM_SUFFIX)) return;
      if (present.has(name.slice(0, -'.claim'.length))) return;
      const file = path.join(REQUESTS_DIR, name);
      try {
        if (Date.now() - (await fs.stat(file)).mtimeMs > STALE_MS)
          await fs.rm(file, { force: true });
      } catch {
        // A taker or another sweep already removed it.
      }
    })
  );
}

/**
 * Claims requests addressed to `windowId`, handing each to `handle` exactly
 * once and publishing what it answered. The request file is removed before the
 * handler runs: one lost to a crash mid-open beats one replayed every tick.
 */
export async function claimRequests(
  windowId: string,
  handle: (request: Request) => Reply | Promise<Reply>
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(REQUESTS_DIR);
  } catch {
    return;
  }
  await sweepStaleClaims(names);

  await Promise.all(
    names
      .filter((name) => name.endsWith(REQUEST_SUFFIX))
      .map(async (name) => {
        const file = path.join(REQUESTS_DIR, name);
        const read = requestCodec.readRequest(await requestJson(file));
        if (!read) {
          return; // unreadable or half-written — the next tick sees it whole
        }
        const request = read.request ?? read.envelope;
        if (request.windowId !== windowId) {
          if (Date.now() - request.createdAt > STALE_MS) {
            await fs.rm(file, { force: true });
          }
          return;
        }
        // Serving a stale open after a window reopens would replay abandoned starts.
        if (Date.now() - request.createdAt > STALE_MS) {
          await fs.rm(file, { force: true });
          return;
        }
        if (!(await take(file))) {
          return; // already claimed
        }

        let reply: Reply;
        try {
          reply = read.request ? await handle(read.request) : { ok: false, reason: MALFORMED };
        } catch (error) {
          // The handler may have performed the action before it threw.
          reply = { ok: false, reason: String(error), unsure: true };
        }
        await fs
          .writeFile(file.replace(REQUEST_SUFFIX, REPLY_SUFFIX), JSON.stringify(reply))
          .catch(() => undefined);
      })
  );

  await Promise.all(
    names
      .filter((name) => name.endsWith(REPLY_SUFFIX))
      .map(async (name) => {
        const file = path.join(REQUESTS_DIR, name);
        try {
          const { mtimeMs } = await fs.stat(file);
          if (Date.now() - mtimeMs > STALE_MS) {
            await fs.rm(file, { force: true });
          }
        } catch {
          // gone already
        }
      })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only the incoming namespace pays this bound; ordinary text and images retain their limits. */
async function requestJson(file: string): Promise<unknown> {
  if (!path.basename(file).startsWith('incoming-')) return readJson<unknown>(file);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > incoming.INCOMING_MAX_BYTES) return undefined;
    const bytes = Buffer.alloc(incoming.INCOMING_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > incoming.INCOMING_MAX_BYTES) return undefined;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
