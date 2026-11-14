/**
 * Admitting one session's message to another, as one sequence: guard, re-read
 * ownership after every await, park or deliver, record the accept, then the
 * interrupt outside the send chain.
 *
 * The decisions are pure and live beside this (`send.ts`, `answer.ts`,
 * `reports.ts`). This is their composition, here rather than in `host/` so a
 * test reaches it: both halves were once tested and the composition was not
 * (`TASK_done_wait_report_attachment.md`: a `Promise<boolean>` tested against
 * `undefined` sent every unparked report nowhere).
 */
import { randomUUID } from 'crypto';
import { refusal, type SessionHandle } from '../adapter';
import { sameSessionStart } from '../model';
import { readActions, serializeSends, writeAction } from './actions';
import { checkVerbAnswer, openQuestion } from './answer';
import {
  type ParkedReport,
  dropReport,
  parkFor,
  readReports,
  releaseAuthor,
  writeReport
} from './reports';
import type { Reply, Request } from './requests';
import * as route from './route';
import { type Recipient, checkResolution, checkVerbSend, wrapMessage, wrapWait } from './send';
import { GONE, NOT_HERE } from './serve_owned';
import { type WaitReport, type WaitResolution, readWaits } from './wait';

/** What admission reads of the window it runs in. */
export type AdmissionPort = {
  owned(pid: number): SessionHandle | undefined;
  /** The window's own reading of the target, not the shim's: a shim that read
   *  a stale published record must not get a cold wake past the guards. */
  target(pid: number): Recipient | undefined;
  readonly windowId: string;
  /** `squadron.orchestrators.enabled`. */
  orchestrators(): boolean;
};

export type Log = (line: string) => void;

type SendRequest = Extract<Request, { kind: 'send' }>;
type AnswerRequest = Extract<Request, { kind: 'answer' }>;

export type Message =
  { kind: 'send'; request: SendRequest } | { kind: 'answer'; request: AnswerRequest };

export type WakeOutcome =
  | { kind: 'delivered'; handle: SessionHandle }
  | { kind: 'refused'; reason: string; handle: SessionHandle | undefined }
  | { kind: 'undelivered'; reason: string; handle: SessionHandle };

export type Wake = {
  kind: 'wait';
  resolution: WaitResolution;
  /** Runs inside the send chain once the outcome is known, for every outcome,
   *  so nothing admitted concurrently lands between a wake (or its refusal)
   *  and the reports it releases. Must not call `serializeSends` or `admit`. */
  settle(outcome: WakeOutcome): Promise<void>;
};

/** One reply's work left for after the chain releases: the interrupt. */
type Accepted = { reply: Reply; after?: () => Promise<void> };

export function admit(message: Message, port: AdmissionPort, log: Log): Promise<Reply>;
export function admit(message: Wake, port: AdmissionPort, log: Log): Promise<WakeOutcome>;
export async function admit(
  message: Message | Wake,
  port: AdmissionPort,
  log: Log
): Promise<Reply | WakeOutcome> {
  if (message.kind === 'wait') {
    return serializeSends(() => wake(message, port));
  }
  const { request } = message;
  const accepted = await serializeSends(() =>
    message.kind === 'send' ? send(message.request, port, log) : answer(message.request, port)
  );
  // After the chain: an interrupt that hangs must not hold every other
  // admission in this window behind it.
  await accepted.after?.();
  // Every reply, a refusal's too, carries the facts read now, after the tail.
  const owned = port.owned(request.pid);
  const messageFacts =
    owned && sameSessionStart(owned.state.startedAt, request.startedAt)
      ? owned.state.messageFacts
      : undefined;
  return { ...accepted.reply, ...(messageFacts === undefined ? {} : { messageFacts }) };
}

async function send(request: SendRequest, port: AdmissionPort, log: Log): Promise<Accepted> {
  const held = holding(request, port);
  if (!held.ok) return { reply: held.reply };
  const { owned, target } = held;
  const decided = checkVerbSend({
    enabled: port.orchestrators(),
    from: request.from,
    windowId: port.windowId,
    target,
    text: request.text,
    now: Date.now(),
    actions: await readActions(),
    force: request.force
  });
  if (!decided.ok) return { reply: { ok: false, reason: decided.reason } };
  if (port.owned(request.pid) !== owned) return { reply: { ok: false, reason: GONE } };
  // Interrupt bypasses parking: breaking in is not filing a report.
  const parked =
    request.interrupt !== true && (await holdForWait(request, decided, owned, port, log));
  if (parked) {
    // Parking is acceptance and counts against the same window burst cap as
    // delivery. Awaited for the reason on the record below.
    await record(port, request, owned, decided.from, 'send');
    return { reply: { ok: true, queued: owned.state.queued.length, heldForWait: request.pid } };
  }
  if (port.owned(request.pid) !== owned) return { reply: { ok: false, reason: GONE } };
  // `describe` is the payload, so what names the session is the message rather
  // than the tag around it: `firstPrompt` feeds the CLI's titler, and a title
  // is persisted into the transcript for every window and every `/resume`.
  const routed = route.routeTo({ owned });
  if (route.isRefused(routed) || !routed.messages) {
    return { reply: { ok: false, reason: refusal('messages') } };
  }
  const messages = routed.messages;
  const sent = await messages.send(
    decided.text,
    [],
    decided.payload,
    request.interrupt === true,
    undefined,
    request.correlation
  );
  if (!sent.ok) return { reply: sent };
  // Awaited, and before the interrupt: the send above is the accept, and a
  // record written after something that can reject or hang is a record the
  // counters do not have when the next request of the same tick reads them.
  await record(port, request, owned, decided.from, 'send');
  if (request.interrupt !== true) return { reply: sent };
  const reply: Reply = { ...sent };
  return {
    reply,
    // Ahead, then `sendNow`: the latch is what makes the interrupt and the
    // delivery one act. Interrupt-then-`send` is the race `sendNow` exists to
    // close — the interrupt's own idle edge drains whatever was already held,
    // and the payload lands a turn later.
    //
    // A refusal is swallowed on purpose: the message is enqueued either way,
    // and an agent told "refused" retries, putting a second copy at the head
    // of the outbox.
    after: async () => {
      if (port.owned(request.pid) === owned) await messages.sendNow();
      // Capture can still hold an outgoing row after send-now returns.
      if (sent.queued !== 0) reply.queued = owned.state.queued.length;
    }
  };
}

async function answer(request: AnswerRequest, port: AdmissionPort): Promise<Accepted> {
  const held = holding(request, port);
  if (!held.ok) return { reply: held.reply };
  const { owned, target } = held;
  const decided = checkVerbAnswer({
    enabled: port.orchestrators(),
    from: request.from,
    windowId: port.windowId,
    target,
    text: request.text,
    now: Date.now(),
    actions: await readActions(),
    force: request.force,
    pending: owned.state.pending,
    askId: request.askId
  });
  if (!decided.ok) return { reply: { ok: false, reason: decided.reason } };
  // Again after the await, and again before the interrupt: the person may
  // answer on the dialog while this window awaits, and an interrupt then cuts
  // the turn their answer started. Closed by the second check, the answer
  // stays an ordinary held message the idle edge delivers.
  // **Accepted:** an interrupt that rejects leaves the prose held too, and it
  // drains after the person answers, saying a dialog was closed that was not —
  // the failure the send interrupt swallows the same way.
  const stillOpen = (): boolean =>
    port.owned(request.pid) === owned && openQuestion(owned.state.pending, request.askId).ok;
  if (!stillOpen()) return { reply: { ok: false, reason: 'That question is no longer open.' } };
  const routed = route.routeTo({ owned });
  if (route.isRefused(routed) || !routed.messages) {
    return { reply: { ok: false, reason: refusal('messages') } };
  }
  const messages = routed.messages;
  // The send interrupt's order, for its reasons: ahead, the record, then
  // `sendNow`, whose refusal is swallowed as the send's is.
  const sent = await messages.send(
    decided.text,
    [],
    decided.payload,
    true,
    undefined,
    request.correlation
  );
  if (!sent.ok) return { reply: { ok: false, reason: sent.reason } };
  await record(port, request, owned, decided.from, 'answer');
  return {
    // The answer's reply carries no `queued`: it was never a queued message.
    reply: { ok: true },
    after: async () => {
      if (stillOpen()) await messages.sendNow();
    }
  };
}

async function wake(message: Wake, port: AdmissionPort): Promise<WakeOutcome> {
  const outcome = await deliverWake(message.resolution, port);
  await message.settle(outcome);
  return outcome;
}

/**
 * A resolution obeys the send guards with no carve-out and no `force`: the
 * stale-cache guard on the requester, and the window's burst shared
 * with verb sends. Every refusal before the send is structural or a guard,
 * and is marked on the wait; only a send that fails is retried.
 */
async function deliverWake(resolution: WaitResolution, port: AdmissionPort): Promise<WakeOutcome> {
  const pid = resolution.requesterPid;
  const owned = port.owned(pid);
  const routed = route.routeTo({ owned });
  if (!owned || route.isRefused(routed) || !routed.messages) {
    return { kind: 'refused', reason: 'that session cannot be sent to from here', handle: owned };
  }
  const verdict = checkResolution({
    windowId: port.windowId,
    target: port.target(pid),
    text: resolution.text,
    now: Date.now(),
    actions: await readActions()
  });
  if (!verdict.ok) return { kind: 'refused', reason: verdict.reason, handle: owned };
  if (port.owned(pid) !== owned) {
    return { kind: 'refused', reason: 'this window no longer drives that session', handle: owned };
  }
  // `resolution.text` is the payload, so what names the turn is the message
  // rather than the tag around it — the same reason a send passes one.
  const sent = await routed.messages.send(wrapWait(resolution.text), [], resolution.text, false);
  if (!sent.ok) return { kind: 'undelivered', reason: sent.reason, handle: owned };
  // `from` is the window, not any session: nothing composed this but this
  // extension host (`actions.ts` has why that is its own record kind).
  await writeAction({
    schema: 1,
    kind: 'wait',
    windowId: port.windowId,
    from: port.windowId,
    toPid: pid,
    toSessionId: owned.state.sessionId,
    at: Date.now()
  });
  return { kind: 'delivered', handle: owned };
}

/**
 * Held reports put on the pipe as ordinary messages, oldest first, each
 * dropped once its send is accepted. A refusal stops the loop and leaves that
 * report and the rest on disk, where `rescue` finds them once their wait is
 * gone: a report is dropped only after it was sent, never because a later one
 * could not be.
 *
 * **The guards are deliberately not re-run.** The guards decide admission, and
 * admission already happened: each of these passed `checkVerbSend` at send
 * time and has an `actions/` record witnessing it. Releasing completes a
 * delivery that was accepted; it does not make a new one. Re-running them
 * after a refusal for the requester's own state would refuse every one for
 * the same reason, and S4's promise that they arrive as N wakes
 * (`PRD_shipped_wait_report_attachment.md`) could never be kept.
 *
 * Wrapped under each report's own author, from the raw payload the store
 * keeps — which is why the store keeps it raw: a stored *wrapped* text
 * embedded in a convergence would be refused by `checkSend`'s forgery guard.
 */
export async function release(
  reports: readonly WaitReport[],
  handle: SessionHandle,
  why: string,
  log: Log
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (reports.length === 0) return { ok: true };
  const routed = route.routeTo({ owned: handle });
  if (route.isRefused(routed) || !routed.messages) {
    return { ok: false, reason: refusal('messages') };
  }
  // Oldest first, always. A correction read before the thing it corrects is
  // worse than either arriving alone.
  const ordered = [...reports].sort((a, b) => a.at - b.at);
  let released = 0;
  for (const report of ordered) {
    const sent = await routed.messages.send(
      wrapMessage(report.payload, releaseAuthor(report)),
      [],
      report.payload,
      false
    );
    if (!sent.ok) {
      log(
        `released ${released} of ${ordered.length} held report(s): ${why}; stopped: ${sent.reason}`
      );
      return { ok: false, reason: sent.reason };
    }
    await dropReport(report.id);
    released++;
  }
  log(`released ${released} held report(s): ${why}`);
  return { ok: true };
}

/** The checks every message makes before its guard, in this order and words. */
function holding(
  request: SendRequest | AnswerRequest,
  port: AdmissionPort
): { ok: true; owned: SessionHandle; target: Recipient } | { ok: false; reply: Reply } {
  const owned = port.owned(request.pid);
  // A stale poll or a departed window's record can route here without a pipe.
  if (!owned) return { ok: false, reply: { ok: false, reason: NOT_HERE } };
  if (!sameSessionStart(owned.state.startedAt, request.startedAt)) {
    return { ok: false, reply: { ok: false, reason: GONE } };
  }
  if (!owned.messages) return { ok: false, reply: { ok: false, reason: refusal('messages') } };
  const target = port.target(request.pid);
  if (!target) return { ok: false, reply: { ok: false, reason: GONE } };
  return { ok: true, owned, target };
}

async function record(
  port: AdmissionPort,
  request: SendRequest | AnswerRequest,
  owned: SessionHandle,
  from: string,
  kind: 'send' | 'answer'
): Promise<void> {
  const base = {
    schema: 1 as const,
    windowId: port.windowId,
    from,
    toPid: request.pid,
    toSessionId: owned.state.sessionId,
    at: Date.now(),
    requestId: request.id
  };
  await writeAction(
    kind === 'answer' && request.kind === 'answer'
      ? { ...base, kind: 'answer', askId: request.askId }
      : { ...base, kind: 'send' }
  );
}

/**
 * Whether this report was held against an open wait instead of delivered.
 *
 * The window half of `PRD_shipped_wait_report_attachment.md`. A fan-out with a
 * wait open costs its parent N+1 wakes — measured 2026-08-26, four wakes for
 * two children — because the children still report and the convergence is an
 * *extra* message on top. Held here, the same words arrive on the convergence
 * and the parent is woken once.
 *
 * **Nothing is refused and nothing is dropped.** A5: the "redundant" report in
 * that run carried a correction to the parent's own brief, so a window may not
 * judge which report is worth keeping. Every path below holds the message or
 * sends it.
 *
 * **The cap releases rather than truncating.** At `REPORTS_PER_MEMBER` the
 * member's held reports go out in the order they were accepted, and this one
 * follows them — so a report that hits the cap can never overtake the ones it
 * might be correcting.
 *
 * Degradation is always "send it normally": an unreadable store, a park that
 * would not write, a sender that cannot be placed. `false` is the answer for
 * every one of them.
 */
async function holdForWait(
  request: SendRequest,
  decided: { payload: string; from: string },
  owned: SessionHandle,
  port: AdmissionPort,
  log: Log
): Promise<boolean> {
  // `decided.from` and not `request.from`: `checkVerbSend` has settled who the
  // sender is, and its rule is that the wrapper's own author wins over the
  // field beside it. Checking one and storing the other would let a
  // hand-written request pass as A and park under B's name.
  const fromPid = trustedSender(request.fromPid, decided.from, port);
  if (fromPid === undefined) return false;
  let held: ParkedReport[];
  let verdict: ReturnType<typeof parkFor>;
  try {
    const [reports, waits] = await Promise.all([readReports(), readWaits()]);
    held = reports;
    verdict = parkFor({ waits, reports, toPid: request.pid, fromPid, now: Date.now() });
  } catch (err) {
    // A store this window cannot read is a feature that does not apply, not a
    // send that fails. Nothing is flushed: this window does not know what is
    // parked, and `rescue` releases them once the store recovers.
    log(
      `could not hold a report for ${request.pid}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
  if (verdict === undefined) return false;
  if (verdict.kind === 'release') {
    await release(
      verdict.reports,
      owned,
      `${fromPid} reached its cap on wait ${verdict.wait.id}`,
      log
    );
    return false;
  }
  const wrote = await writeReport({
    schema: 1,
    id: randomUUID(),
    waitId: verdict.wait.id,
    requesterPid: request.pid,
    senderPid: fromPid,
    senderSessionId: decided.from,
    payload: decided.payload,
    at: Date.now()
  });
  if (!wrote) {
    // **Degrading must not reorder.** This send is about to go out now, so what
    // this member already has parked goes out ahead of it — otherwise a full
    // disk turns the fourth report into the first one the parent reads.
    const waitId = verdict.wait.id;
    await release(
      held.filter((one) => one.waitId === waitId && one.senderPid === fromPid),
      owned,
      'its park would not write',
      log
    );
  }
  return wrote;
}

/**
 * A sender this window drives, checked against its in-memory sessionId — no
 * process scan on the send path; the shim already resolved the board's pid. A
 * cross-window sender is trusted like `from`: forging `fromPid` can only hold
 * the message, not bypass guards or deliver it somewhere otherwise refused.
 */
function trustedSender(
  fromPid: number | undefined,
  from: string,
  port: AdmissionPort
): number | undefined {
  if (fromPid === undefined) return undefined;
  const claimed = port.owned(fromPid);
  if (claimed && claimed.state.sessionId !== from) return undefined;
  return fromPid;
}
