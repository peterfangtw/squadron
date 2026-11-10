import * as origin from './origin';
import * as incoming from '../incoming';
import type { IncomingDelivery, IncomingDenied } from '../bridge/model';
import { isCorrelation, readMessageFacts } from '../message_facts';
import { isBrand } from '../brands';
import { isStartWord } from '../start_outcome';
import type { ImageBlock, LaunchTarget, SendTarget } from '../model';
import type { Reply, Request, RequestBody } from './requests';

/** What every request file carries, whatever its kind. */
type Envelope = { id: string; createdAt: number; windowId: string };

/**
 * A request file as this build reads it: the envelope, and the body narrowed
 * field by field to its kind, because another process wrote it and every
 * guard downstream reads the fields its kind declares. `request`
 * is absent when a field this build knows is missing or of the wrong type;
 * the window answers that `MALFORMED`. Fields it does not know are dropped.
 *
 * A kind it does not know is handed on whole, so the window answers it as a
 * newer build's ("older Squadron") rather than as unreadable. Undefined is no
 * envelope at all: a file still being written, read again next tick.
 */
export function readRequest(raw: unknown): { envelope: Envelope; request?: Request } | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, createdAt, windowId, kind } = raw;
  if (typeof id !== 'string' || typeof createdAt !== 'number' || typeof windowId !== 'string') {
    return undefined;
  }
  const envelope = { id, createdAt, windowId };
  if (typeof kind === 'string' && incomingKind(kind)) {
    if (
      !incoming.incomingUuid(id) ||
      !incoming.incomingString(windowId) ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      !incoming.incomingBounded(raw)
    )
      return { envelope };
  }
  if (typeof kind !== 'string') return { envelope };
  // The one cast left: a newer build's kind, whose fields this one cannot name.
  if (!isKind(kind)) return { envelope, request: raw as Request };
  try {
    const body = bodyOf(kind, raw, windowId);
    if (!origin.validOrigin(body, raw.origin)) throw new Malformed('origin');
    return {
      envelope,
      request: {
        ...body,
        ...(raw.origin === undefined ? {} : { origin: raw.origin as origin.RequestOrigin }),
        id,
        createdAt
      }
    };
  } catch (err) {
    if (err instanceof Malformed) return { envelope };
    throw err;
  }
}

/** Every kind this build serves; a kind added to `RequestBody` fails here. */
const KINDS: Record<RequestBody['kind'], true> = {
  models: true,
  remoteStartFilesV1: true,
  incomingEvidenceV1: true,
  fetchFile: true,
  open: true,
  send: true,
  answer: true,
  rename: true,
  warm: true,
  close: true,
  interrupt: true,
  deny: true,
  personAnswer: true,
  attach: true
};

function isKind(kind: string): kind is RequestBody['kind'] {
  return Object.prototype.hasOwnProperty.call(KINDS, kind);
}

type Fields = Record<string, unknown>;

class Malformed extends Error {}

function bodyOf(kind: RequestBody['kind'], raw: Fields, windowId: string): RequestBody {
  const at = () => ({
    windowId,
    pid: need(raw, 'pid', isNumber),
    startedAt: need(raw, 'startedAt', isNumber)
  });
  switch (kind) {
    case 'remoteStartFilesV1':
    case 'incomingEvidenceV1':
    case 'fetchFile':
      return incomingBody(kind, raw, windowId);
    case 'models':
      return { kind, windowId };
    case 'open':
      return defined({
        kind,
        windowId,
        cwd: need(raw, 'cwd', isString),
        prompt: may(raw, 'prompt', isString),
        correlation: may(raw, 'correlation', isCorrelation),
        name: may(raw, 'name', isString),
        parentSessionId: may(raw, 'parentSessionId', isString),
        originSessionId: may(raw, 'originSessionId', isString),
        from: may(raw, 'from', isString),
        ticketRef: may(raw, 'ticketRef', isString),
        workflowId: may(raw, 'workflowId', isString),
        resume: may(raw, 'resume', isString),
        // A string, not a known brand: the window refuses one it has no
        // adapter for, and an absent brand must stay distinct from it.
        brand: may(raw, 'brand', isString),
        model: may(raw, 'model', isString),
        window: may(raw, 'window', isNumber),
        effort: may(raw, 'effort', isString),
        selection: may(
          raw,
          'selection',
          (v): v is 'catalog' | 'default' => v === 'catalog' || v === 'default'
        ),
        via: may(raw, 'via', (v): v is 'remote' => v === 'remote'),
        remote: may(raw, 'remote', isString)
      });
    case 'send':
      return defined({
        incomingDelivery: deliveryOf(raw),
        incomingHolder: incoming.readIncomingHolder(raw.incomingHolder),
        kind,
        ...at(),
        text: need(raw, 'text', isString),
        correlation: may(raw, 'correlation', isCorrelation),
        images: may(raw, 'images', isImages),
        target: may(raw, 'target', isTarget),
        via: may(raw, 'via', (v): v is 'verb' => v === 'verb'),
        remote: may(raw, 'remote', isString),
        from: may(raw, 'from', isString),
        fromPid: may(raw, 'fromPid', isNumber),
        interrupt: may(raw, 'interrupt', isBoolean),
        force: may(raw, 'force', isBoolean)
      });
    case 'answer':
      return defined({
        kind,
        ...at(),
        askId: need(raw, 'askId', isString),
        text: need(raw, 'text', isString),
        correlation: may(raw, 'correlation', isCorrelation),
        from: may(raw, 'from', isString),
        force: may(raw, 'force', isBoolean)
      });
    case 'rename':
      return { kind, ...at(), title: need(raw, 'title', isString) };
    case 'warm':
      return { kind, ...at(), on: need(raw, 'on', isBoolean) };
    case 'close':
      return { kind, ...at() };
    case 'interrupt':
      return { kind, ...at(), remote: need(raw, 'remote', isString) };
    case 'deny':
      return defined({
        kind,
        ...at(),
        requestId: need(raw, 'requestId', isString),
        reason: may(raw, 'reason', isString),
        remote: need(raw, 'remote', isString)
      });
    case 'personAnswer':
      return defined({
        incomingDelivery: deliveryOf(raw),
        incomingHolder: incoming.readIncomingHolder(raw.incomingHolder),
        kind,
        ...at(),
        askId: need(raw, 'askId', isString),
        text: need(raw, 'text', isString),
        correlation: may(raw, 'correlation', isCorrelation),
        remote: need(raw, 'remote', isString)
      });
    case 'attach':
      return defined({
        kind,
        ...at(),
        sessionWindowId: need(raw, 'sessionWindowId', isString),
        path: need(raw, 'path', isString),
        caption: may(raw, 'caption', isString),
        from: need(raw, 'from', isString)
      });
  }
}

function need<T>(raw: Fields, key: string, is: (value: unknown) => value is T): T {
  const value = raw[key];
  if (!is(value)) throw new Malformed(key);
  return value;
}

/** Absent is fine; present and of another type is not. */
function may<T>(raw: Fields, key: string, is: (value: unknown) => value is T): T | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!is(value)) throw new Malformed(key);
  return value;
}

/** Without its absent fields, so `'effort' in request` says what the file said. */
function defined<T extends object>(body: T): T {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as T;
}

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isImages(value: unknown): value is ImageBlock[] {
  return (
    Array.isArray(value) &&
    value.every((one) => isRecord(one) && isString(one.mediaType) && isString(one.data))
  );
}

/**
 * The flat brand, model, window and effort of an open request file, as one
 * LaunchTarget. An absent field stays absent. A present field of the wrong
 * type, or a brand this build does not start, refuses the whole target:
 * dropping the bad field would start a different pick.
 */
export function launchTargetOf(raw: {
  brand?: unknown;
  model?: unknown;
  window?: unknown;
  effort?: unknown;
}): LaunchTarget | undefined {
  const { brand, model, window, effort } = raw;
  if (brand !== undefined && !isBrand(brand)) return undefined;
  if (model !== undefined && !isString(model)) return undefined;
  if (window !== undefined && !isNumber(window)) return undefined;
  if (effort !== undefined && !isString(effort)) return undefined;
  const target: LaunchTarget = {};
  if (isBrand(brand)) target.brand = brand;
  if (isString(model)) target.model = model;
  if (isNumber(window)) target.window = window;
  if (isString(effort)) target.effort = effort;
  return target;
}

function isTarget(value: unknown): value is SendTarget {
  return (
    isRecord(value) &&
    (value.model === undefined || isString(value.model)) &&
    (value.window === undefined || isNumber(value.window)) &&
    (value.effort === undefined || isString(value.effort))
  );
}

export function incomingKind(kind: string): boolean {
  return ['remoteStartFilesV1', 'incomingEvidenceV1', 'fetchFile'].includes(kind);
}

function incomingBody(
  kind: 'remoteStartFilesV1' | 'incomingEvidenceV1' | 'fetchFile',
  raw: Fields,
  windowId: string
): RequestBody {
  if (raw.version !== 1) throw new Malformed('version');
  if (kind === 'fetchFile') {
    const identity = incoming.readFetchFileIdentity(raw);
    if (!identity || windowId !== identity.holder.host.windowId) throw new Malformed('identity');
    return { kind, version: 1, windowId, ...identity };
  }
  const expectedHost = incoming.readHostIdentity(raw.expectedHost);
  if (!expectedHost || windowId !== expectedHost.windowId) throw new Malformed('host');
  const base = { kind, version: 1 as const, windowId, expectedHost };
  if (kind === 'incomingEvidenceV1') {
    const holder =
      typeof raw.query === 'object' &&
      raw.query &&
      'kind' in raw.query &&
      raw.query.kind === 'holder' &&
      'holder' in raw.query
        ? incoming.readIncomingHolder(raw.query.holder)
        : undefined;
    if (
      holder &&
      incoming.incomingUuid(raw.challenge) &&
      incoming.sameHost(expectedHost, holder.host)
    )
      return { ...base, kind, challenge: raw.challenge, query: { kind: 'holder', holder } };
    const query = incoming.readIncomingEvidenceQuery(raw.query);
    if (
      !query ||
      !incoming.incomingUuid(raw.challenge) ||
      !incoming.sameHost(
        expectedHost,
        query.kind === 'attempt'
          ? query.attempt.host
          : query.kind === 'receiver'
            ? query.receiver.host
            : query.delivery.receiver.host
      )
    )
      throw new Malformed('query');
    return { ...base, kind, challenge: raw.challenge, query };
  }
  const attempt = incoming.readLaunchAttempt(raw.attempt);
  if (!attempt || !incoming.sameHost(expectedHost, attempt.host)) throw new Malformed('attempt');
  if (
    !incoming.incomingPath(raw.localRoot) ||
    typeof raw.prompt !== 'string' ||
    raw.prompt.trim().length === 0 ||
    Buffer.from(raw.prompt, 'utf8').toString('utf8') !== raw.prompt
  )
    throw new Malformed('prompt');
  return { ...base, kind, attempt, localRoot: raw.localRoot, prompt: raw.prompt };
}

export function deliveryOf(raw: Fields): IncomingDelivery | IncomingDenied | undefined {
  if (raw.incomingDelivery === undefined) return undefined;
  const delivery = incoming.readIncomingDelivery(raw.incomingDelivery);
  return delivery &&
    delivery.correlation === raw.correlation &&
    delivery.receiver.pid === raw.pid &&
    delivery.receiver.host.windowId === raw.windowId
    ? delivery
    : { version: 1, denied: 'admission-denied' };
}

/** Invalid optional trust fields are stripped; invalid success receipts become an explicit refusal. */
export function readReply(raw: unknown): Reply | undefined {
  if (!isRecord(raw) || typeof raw.ok !== 'boolean') return undefined;
  if (
    raw.closeFailure !== undefined &&
    (raw.ok ||
      (raw.closeFailure !== 'unavailable' &&
        raw.closeFailure !== 'failed' &&
        raw.closeFailure !== 'gone'))
  )
    return { ok: false, reason: 'Invalid close result.' };
  const {
    messageFacts: facts,
    incomingAccess: access,
    remoteLaunchEvidence: launch,
    incomingDelivery: delivery,
    incomingEvidence: evidence,
    incomingHolderEvidence: holderEvidence,
    fetchFile: fetch,
    incomingRefusal: refusal,
    outcome: word,
    ...body
  } = raw;
  const outcome = isStartWord(word) ? word : undefined;
  const messageFacts = readMessageFacts(facts);
  const incomingAccess = incoming.readIncomingAccess(access);
  const remoteLaunchEvidence = incoming.readRemoteLaunchEvidence(launch);
  const incomingDelivery = incoming.readIncomingDeliveryEvidence(delivery);
  const incomingEvidence = incoming.readIncomingEvidence(evidence);
  const holder = isRecord(holderEvidence)
    ? incoming.readIncomingHolder(holderEvidence.holder)
    : undefined;
  const incomingHolderEvidence =
    holder && isRecord(holderEvidence) && incoming.incomingUuid(holderEvidence.challenge)
      ? Object.freeze({ challenge: holderEvidence.challenge, holder })
      : undefined;
  const fetchFile = incoming.readFetchFileReply(fetch);
  if (
    [
      [launch, remoteLaunchEvidence],
      [delivery, incomingDelivery],
      [evidence, incomingEvidence],
      [holderEvidence, incomingHolderEvidence],
      [fetch, fetchFile]
    ].some(([value, decoded]) => value !== undefined && decoded === undefined) ||
    (fetchFile !== undefined && raw.ok !== (fetchFile.kind === 'fetched')) ||
    (raw.ok &&
      (refusal !== undefined ||
        (remoteLaunchEvidence && remoteLaunchEvidence.stage !== 'accepted')))
  )
    return {
      ok: false,
      incomingRefusal: 'evidence-unavailable',
      reason: 'Incoming file evidence could not be read.',
      ...(messageFacts === undefined ? {} : { messageFacts }),
      ...(raw.ok ? { unsure: true as const } : {})
    };
  return {
    ...body,
    ...(outcome === undefined ? {} : { outcome }),
    ...(messageFacts === undefined ? {} : { messageFacts }),
    ...(incomingAccess === undefined ? {} : { incomingAccess }),
    ...(remoteLaunchEvidence === undefined ? {} : { remoteLaunchEvidence }),
    ...(incomingDelivery === undefined ? {} : { incomingDelivery }),
    ...(incomingEvidence === undefined ? {} : { incomingEvidence }),
    ...(incomingHolderEvidence === undefined ? {} : { incomingHolderEvidence }),
    ...(fetchFile === undefined ? {} : { fetchFile }),
    ...(incoming.incomingRefusal(refusal) ? { incomingRefusal: refusal } : {})
  } as Reply;
}
