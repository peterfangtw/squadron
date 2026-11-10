/**
 * The window-side arms the Remote host relies on: what a window does with a
 * request about a session it drives, when the request needs no setting and no
 * actions store. `isClassifiedOwned` admits composer-send, remote-send,
 * remote-open, remote-interrupt, remote-deny, remote-answer,
 * remote-start-files, evidence, close, and unknown, so a test of a second window runs the code a
 * real window runs; `host/request_host.ts`'s `serve` hands the verb `send` and
 * `answer` to `admit.ts`, keeps `rename`, `warm`, `models` and the agent `open`,
 * and hands `attach` to `core/remote/serve_attach.ts`.
 */

import * as incoming from '../incoming';
import type {
  IncomingDelivery,
  IncomingEvidence,
  IncomingEvidenceQuery,
  IncomingAccess
} from '../bridge/model';
import { launchTargetOf } from './request_codec';
import { MALFORMED, type RemoteStartFilesV1 } from './requests';
import * as origin from './origin';
import { brandForStart, refusal, type SessionHandle } from '../adapter';
import type { Holder } from '../remote/holder';
import { sameSessionStart, type BrandId, type Decision } from '../model';
import { openQuestion, personAnswerProse } from './answer';
import type { Reply, Request } from './requests';
import { isRefused, routeTo, type RoutedHandle } from './route';

/** A person's start from Remote: the default pick, or `brand` on its account
 *  default (D23's fresh session). */
export type RemoteStart = import('../model').LaunchTarget & {
  cwd: string;
  prompt?: string;
  correlation?: string;
  name?: string;
  selection?: import('../model_listing').SelectionSource;
};

export type RemoteFilesStart = Omit<RemoteStartFilesV1, 'kind' | 'windowId'>;

export type ServePort = {
  /** This window's handle for a pid. */
  owned(pid: number): SessionHandle | undefined;
  /** End it the way the panel's End does; false when nothing here holds it. */
  end(pid: number, startedAt: number): boolean;
  ending?(pid: number, startedAt: number): boolean;
  start(start: RemoteStart): Promise<
    | { ok: true; pid: number; startedAt: number; brand: BrandId }
    | {
        ok: false;
        reason: string;
        cause?: 'pick';
        outcome: import('../start_outcome').FailedWord;
        selectionInvalid?: true;
      }
  >;
  incomingHolder?(): Promise<Holder | undefined>;
  currentIncomingHolder?(): import('../bridge/model').IncomingHolder | undefined;
  incomingStarts?: import('../owned_incoming').IncomingLaunches;
  startFiles?(start: RemoteFilesStart): Promise<Reply>;
  incomingAccess?(): Promise<IncomingAccess | undefined>;
  evidence?(challenge: string, query: IncomingEvidenceQuery): Promise<IncomingEvidence | undefined>;
  deliverIncoming?(
    pid: number,
    delivery: IncomingDelivery,
    outcome: 'send' | 'person-answer',
    send: () => Promise<Reply>
  ): Promise<Reply>;
  /** The live Remote holder, read against the process table. */
  holder(): Promise<Holder | undefined>;
};

type Of<K extends Request['kind']> = Extract<Request, { kind: K }>;

/**
 * Every shape `serveOwned` answers for: everything but the host's own, so a
 * kind added to `RequestBody` lands here and fails the build until it has an
 * arm.
 */
export type OwnedRequest =
  | Exclude<
      Request,
      | Of<'models'>
      | Of<'answer'>
      | Of<'rename'>
      | Of<'warm'>
      | Of<'send'>
      | Of<'open'>
      | Of<'attach'>
      | Of<'fetchFile'>
    >
  | (Of<'send'> & { via?: undefined })
  | (Of<'open'> & { via: 'remote' });

const OLDER =
  'The window driving that session runs an older Squadron. Reload that window and try again.';
export const NOT_HERE = 'This window does not drive that session.';
export const GONE = 'That session is no longer there.';
const REMOTE_OFF = 'Remote is off.';

export type ClassifiedOwnedRequest = Extract<
  origin.ClassifiedRequest,
  {
    policy:
      | 'composer-send'
      | 'remote-send'
      | 'remote-open'
      | 'remote-interrupt'
      | 'remote-deny'
      | 'remote-answer'
      | 'remote-start-files'
      | 'evidence'
      | 'close'
      | 'unknown';
  }
>;

/** No legacy inference here: the host carries its one ingress decision. */
export function isClassifiedOwned(
  classified: origin.ClassifiedRequest
): classified is ClassifiedOwnedRequest {
  switch (classified.policy) {
    case 'composer-send':
    case 'remote-send':
    case 'remote-open':
    case 'remote-interrupt':
    case 'remote-deny':
    case 'remote-answer':
    case 'remote-start-files':
    case 'evidence':
    case 'close':
    case 'unknown':
      return true;
    default:
      return false;
  }
}

export function serveOwned(request: OwnedRequest, port: ServePort): Promise<Reply>;
export function serveOwned(request: Request, port: ServePort): Promise<Reply> | undefined;
export function serveOwned(request: Request, port: ServePort): Promise<Reply> | undefined {
  const classified = origin.classifyRequest(request);
  if (!classified) return Promise.resolve({ ok: false, reason: MALFORMED });
  return isClassifiedOwned(classified) ? serveClassifiedOwned(classified, port) : undefined;
}

export async function serveClassifiedOwned(
  classified: ClassifiedOwnedRequest,
  port: ServePort
): Promise<Reply> {
  if (classified.policy === 'remote-send' && !(await holds(port, classified.request.remote)))
    return { ok: false, reason: REMOTE_OFF };
  return serve(classified.request, port);
}

export const INCOMING_UNAVAILABLE = 'Incoming file access is unavailable in this build.';

async function serve(request: ClassifiedOwnedRequest['request'], port: ServePort): Promise<Reply> {
  switch (request.kind) {
    case 'remoteStartFilesV1':
      return serveIncomingStart(request, port);
    case 'incomingEvidenceV1':
      return serveIncomingEvidence(request, port);
  }
  if (request.kind === 'open') return serveRemoteOpen(request, port);
  if (remoteKind(request) && !(await holds(port, request.remote))) {
    return { ok: false, reason: REMOTE_OFF };
  }

  if (!['send', 'close', 'interrupt', 'deny', 'personAnswer'].includes(request.kind))
    return { ok: false, reason: OLDER };
  if (request.kind === 'close' && port.ending?.(request.pid, request.startedAt))
    return { ok: true };
  const owned = port.owned(request.pid);
  if (!owned)
    return {
      ok: false,
      reason: NOT_HERE,
      ...(request.kind === 'close' ? { closeFailure: 'unavailable' as const } : {})
    };
  if (owned.state.startedAt !== request.startedAt) {
    return {
      ok: false,
      reason: GONE,
      ...(request.kind === 'close' ? { closeFailure: 'gone' as const } : {})
    };
  }
  return serveHeld(request, owned, port);
}

async function serveIncomingStart(
  request: Of<'remoteStartFilesV1'>,
  port: ServePort
): Promise<Reply> {
  if (!port.startFiles || !port.incomingAccess || !port.incomingStarts)
    return {
      ok: false,
      reason: INCOMING_UNAVAILABLE,
      incomingRefusal: 'unsupported-capability',
      outcome: 'stopped'
    };
  return port.incomingStarts.run(request, async () => {
    const capability = await port.incomingAccess?.();
    if (!capability || !incoming.sameHost(capability.host, request.expectedHost))
      return {
        ok: false,
        reason: 'That starting window changed or is unavailable.',
        incomingRefusal: 'evidence-unavailable',
        outcome: 'unknown'
      };
    const holder = await port.incomingHolder?.();
    if (
      capability.localRoot !== request.localRoot ||
      !holder?.incoming ||
      !incoming.sameHost(holder.incoming.host, request.attempt.holder.host) ||
      holder.incoming.generation !== request.attempt.holder.generation
    )
      return {
        ok: false,
        reason: 'Incoming start destination or holder changed.',
        incomingRefusal: 'evidence-unavailable',
        outcome: 'stopped'
      };
    return (
      port.startFiles?.(request) ?? {
        ok: false,
        reason: INCOMING_UNAVAILABLE,
        outcome: 'stopped'
      }
    );
  });
}

async function serveIncomingEvidence(
  request: Of<'incomingEvidenceV1'>,
  port: ServePort
): Promise<Reply> {
  if (request.query.kind === 'holder') {
    const capability = await port.incomingAccess?.();
    const holder = port.currentIncomingHolder?.();
    return capability &&
      holder &&
      incoming.sameHost(capability.host, request.expectedHost) &&
      incoming.sameHost(holder.host, request.query.holder.host) &&
      holder.generation === request.query.holder.generation
      ? { ok: true, incomingHolderEvidence: { challenge: request.challenge, holder } }
      : { ok: false, reason: REMOTE_OFF, incomingRefusal: 'remote-off' };
  }
  if (!port.evidence || !port.incomingAccess)
    return {
      ok: false,
      reason: INCOMING_UNAVAILABLE,
      incomingRefusal: 'unsupported-capability'
    };
  const capability = await port.incomingAccess();
  const holder = await port.incomingHolder?.();
  if (!holder?.incoming || !capability || !incoming.sameHost(capability.host, request.expectedHost))
    return {
      ok: false,
      reason: 'The owning activation changed.',
      incomingRefusal: 'evidence-unavailable'
    };
  const evidence = await port.evidence(request.challenge, request.query);
  return evidence
    ? { ok: true, incomingEvidence: evidence }
    : {
        ok: false,
        reason: 'Live receiving evidence is unavailable.',
        incomingRefusal: 'evidence-unavailable'
      };
}

async function serveRemoteOpen(request: Of<'open'>, port: ServePort): Promise<Reply> {
  if (!(await holds(port, request.remote)))
    return {
      ok: false,
      reason: REMOTE_OFF,
      outcome: 'stopped'
    };
  const asked = brandForStart(request.brand);
  const target = asked.ok
    ? launchTargetOf({
        brand: asked.brand,
        model: request.model,
        window: request.window,
        effort: request.effort
      })
    : undefined;
  if (!asked.ok || !target) {
    if (request.selection !== undefined) {
      return {
        ok: false,
        reason: 'That model, context or effort is no longer available. Choose again.',
        outcome: 'stopped',
        selectionInvalid: true
      };
    }
    return {
      ok: false,
      reason: asked.ok ? MALFORMED : asked.reason,
      cause: 'pick',
      outcome: 'stopped'
    };
  }
  // No `requestId`: a person's start writes no lineage and is not in the Fleet.
  const started = await port.start({
    ...target,
    cwd: request.cwd,
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    ...(request.correlation === undefined ? {} : { correlation: request.correlation }),
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.selection === undefined ? {} : { selection: request.selection })
  });
  const owned = started.ok ? port.owned(started.pid) : undefined;
  const messageFacts =
    started.ok && owned && sameSessionStart(owned.state.startedAt, started.startedAt)
      ? owned.state.messageFacts
      : undefined;
  return { ...started, ...(messageFacts === undefined ? {} : { messageFacts }) };
}

/**
 * The kinds only Remote posts. Guarded by kind rather than by whether `remote`
 * is there: a file written without the field is still one of these.
 */
function remoteKind(
  request: ClassifiedOwnedRequest['request']
): request is Of<'interrupt'> | Of<'deny'> | Of<'personAnswer'> {
  switch (request.kind) {
    case 'interrupt':
    case 'deny':
    case 'personAnswer':
      return true;
    case 'send':
    case 'close':
    case 'open':
    case 'remoteStartFilesV1':
    case 'incomingEvidenceV1':
      return false;
    default:
      request satisfies never;
      return false;
  }
}

/** A request about a session that names one, past the guard. */
export type HeldRequest = Bare<
  Exclude<
    ClassifiedOwnedRequest['request'],
    Of<'open'> | Of<'remoteStartFilesV1'> | Of<'incomingEvidenceV1'>
  >
>;

/** A request as a window serves it, without the envelope it arrived in. */
type Bare<T> = T extends unknown ? Omit<T, 'id' | 'createdAt'> : never;

/**
 * What a window does with a request about a session it holds at that start,
 * once the guard has passed. The Remote host's own window runs the same arms
 * on its handles in memory (`core/remote/verbs.ts`), so a verb acts alike
 * whichever window drives the session.
 */
export function serveHeld(
  request: HeldRequest,
  owned: SessionHandle,
  port: Pick<ServePort, 'owned' | 'end' | 'deliverIncoming'> &
    Partial<Pick<ServePort, 'incomingHolder'>>
): Promise<Reply> {
  if (
    (request.kind === 'send' || request.kind === 'personAnswer') &&
    request.incomingDelivery &&
    !('denied' in request.incomingDelivery)
  ) {
    const delivery = request.incomingDelivery;
    if (!port.deliverIncoming)
      return Promise.resolve({
        ok: false,
        reason: INCOMING_UNAVAILABLE,
        incomingRefusal: 'unsupported-capability'
      });
    const { incomingDelivery: _incoming, ...ordinary } = request;
    return (async () => {
      const holder = await port.incomingHolder?.();
      if (
        !holder?.incoming ||
        !request.incomingHolder ||
        !incoming.sameHost(holder.incoming.host, request.incomingHolder.host) ||
        holder.incoming.generation !== request.incomingHolder.generation
      )
        return { ok: false, reason: REMOTE_OFF, incomingRefusal: 'remote-off' };
      if (!port.deliverIncoming)
        return {
          ok: false,
          reason: INCOMING_UNAVAILABLE,
          incomingRefusal: 'unsupported-capability'
        };
      return port.deliverIncoming(
        request.pid,
        delivery,
        request.kind === 'send' ? 'send' : 'person-answer',
        () => serveHeld(ordinary, owned, port)
      );
    })();
  }
  switch (request.kind) {
    case 'send':
      return composerSend(request, owned);
    case 'close': {
      try {
        return Promise.resolve(
          port.end(request.pid, request.startedAt)
            ? { ok: true }
            : { ok: false, closeFailure: 'failed', reason: 'Its pipe would not close.' }
        );
      } catch (error) {
        return Promise.resolve({
          ok: false,
          closeFailure: 'failed',
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
    case 'interrupt': {
      const turn = wrapped(owned).turn;
      if (!turn) return Promise.resolve({ ok: false, reason: refusal('turn') });
      return turn.interrupt();
    }
    case 'deny':
      return deny(request, owned);
    case 'personAnswer':
      return personAnswer(request, owned, port);
    default:
      // A kind added to `RequestBody` without an arm fails the build here and
      // names itself; at runtime this is a request from a newer window, which
      // a deploy this window never reloaded into explains.
      request satisfies never;
      return Promise.resolve({ ok: false, reason: OLDER });
  }
}

/** The handle with every throw turned into a sentence. `routeTo` refuses only
 *  a missing handle, and this one is held. */
function wrapped(owned: SessionHandle): RoutedHandle {
  const route = routeTo({ owned });
  return isRefused(route) ? {} : route;
}

/** Whether `remote` names the live holder, judged by its pid alone; not a
 *  security boundary (`core/remote/holder.ts`). */
async function holds(port: ServePort, remote: string | undefined): Promise<boolean> {
  if (remote === undefined) return false;
  return (await port.holder())?.windowId === remote;
}

/**
 * The panel's composer, from another window. How deep this window's outbox is
 * left rides back, since only this window can see it: the asking one records a
 * run as running off a drained outbox, and `ok` alone would say "on the pipe"
 * about a message being held.
 */
async function composerSend(request: Bare<Of<'send'>>, owned: SessionHandle): Promise<Reply> {
  const messages = wrapped(owned).messages;
  if (!messages) return { ok: false, reason: refusal('messages') };
  return messages.send(
    request.text,
    request.images ?? [],
    undefined,
    undefined,
    request.target,
    request.correlation
  );
}

/** The refusal is built here, from the request's id alone: nothing on the wire
 *  is read as a decision, so a forged `allow` denies all the same (D18). */
async function deny(request: Bare<Of<'deny'>>, owned: SessionHandle): Promise<Reply> {
  const asks = wrapped(owned).asks;
  if (!asks) return { ok: false, reason: refusal('asks') };
  const open = owned.state.pending.find((one) => one.requestId === request.requestId);
  if (!open) return { ok: false, reason: 'That request is no longer open.' };
  const decision: Decision =
    open.canDenyReason === false || !request.reason
      ? { allow: false }
      : { allow: false, message: request.reason };
  return asks.respond(request.requestId, decision);
}

/**
 * A person's typed answer: ahead and then drained while the question is open,
 * which withdraws it, or an ordinary message once it has closed.
 *
 * Checked again after the send's await, as `serve`'s `answer` arm does: the
 * person may answer on the dialog meanwhile, and an interrupt then would cut
 * the turn their click began. Closed by that check, the words stay held and
 * the idle edge delivers them.
 */
async function personAnswer(
  request: Bare<Of<'personAnswer'>>,
  owned: SessionHandle,
  port: Pick<ServePort, 'owned'>
): Promise<Reply> {
  const messages = wrapped(owned).messages;
  if (!messages) return { ok: false, reason: refusal('messages') };
  const stillOpen = (): boolean =>
    port.owned(request.pid) === owned && openQuestion(owned.state.pending, request.askId).ok;
  if (!stillOpen()) {
    return messages.send(
      request.text,
      undefined,
      undefined,
      undefined,
      undefined,
      request.correlation
    );
  }
  const sent = await messages.send(
    personAnswerProse(request.text),
    [],
    request.text,
    true,
    undefined,
    request.correlation
  );
  if (!sent.ok) return sent;
  // Swallowed as `send --interrupt` swallows it: the words are already held, and
  // a refusal here would have the person send them twice.
  if (!stillOpen()) return sent;
  // Send-now writes the whole outbox as one message, so nothing is left held,
  // though its drain may still be behind the capture.
  await messages.sendNow();
  return {
    ok: true,
    queued: 0,
    ...(owned.state.messageFacts === undefined ? {} : { messageFacts: owned.state.messageFacts })
  };
}
