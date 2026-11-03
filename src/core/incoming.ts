import * as crypto from 'crypto';
import * as path from 'path';
import { isBrand } from './brands';
import type { LaunchTarget } from './model';
import { isCorrelation } from './message_facts';
import { isStartSource } from './platform/processes';
import type {
  FetchFileIdentity,
  FetchFileReply,
  HostIdentity,
  IncomingAccess,
  IncomingAdmission,
  IncomingDelivery,
  IncomingDeliveryEvidence,
  IncomingDenied,
  IncomingDescriptors,
  IncomingEvidence,
  IncomingEvidenceQuery,
  IncomingFile,
  IncomingHolder,
  IncomingRefusal,
  LaunchAttempt,
  ReceiverIdentity,
  RemoteLaunchEvidence
} from './bridge/model';

export const INCOMING_MAX_BYTES = 64 * 1024;
export const INCOMING_MAX_FILES = 10;
export const INCOMING_FILE_MAX_BYTES = 10 * 1024 * 1024;
const DENIED: IncomingDenied = Object.freeze({ version: 1, denied: 'admission-denied' });

export function incomingString(value: unknown, max = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && (code < 127 || code > 159);
    }) &&
    Buffer.byteLength(value, 'utf8') <= max &&
    Buffer.from(value, 'utf8').toString('utf8') === value
  );
}

export function incomingUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

export function incomingDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function incomingPath(value: unknown): value is string {
  return incomingString(value, 4096) && path.isAbsolute(value) && path.resolve(value) === value;
}

export function incomingBounded(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= INCOMING_MAX_BYTES;
  } catch {
    return false;
  }
}

export function readIncomingDescriptors(
  value: unknown
): IncomingDescriptors | IncomingDenied | undefined {
  if (value === undefined) return undefined;
  if (
    !record(value) ||
    !incomingBounded(value) ||
    value.version !== 1 ||
    !incomingString(value.installId) ||
    !Array.isArray(value.files) ||
    !integer(value.omitted)
  )
    return DENIED;
  const files: IncomingFile[] = [];
  const seen = new Map<string, IncomingFile>();
  let omitted = value.omitted;
  for (const raw of value.files as unknown[]) {
    const file = readFile(raw);
    if (!file) return DENIED;
    const old = seen.get(file.id);
    if (old) {
      if (old.source !== file.source || old.cacheKey !== file.cacheKey) return DENIED;
      continue;
    }
    seen.set(file.id, file);
    if (files.length < INCOMING_MAX_FILES) files.push(file);
    else omitted++;
  }
  if (!integer(omitted)) return DENIED;
  return Object.freeze({
    version: 1,
    installId: value.installId,
    files: Object.freeze(files),
    omitted
  });
}

/** Fixed tuple positions, including null optionals, are the version-1 digest contract. */
export function admissionDigest(admission: Omit<IncomingAdmission, 'digest'>): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        admission.version,
        admission.id,
        admission.ref,
        admission.correlation,
        admission.eventAt,
        admission.admittedAt,
        admission.senderId,
        admission.messengerId,
        admission.installId,
        admission.files.map((file) => [
          file.id,
          file.source,
          file.cacheKey,
          file.name ?? null,
          file.mime ?? null,
          file.size ?? null
        ])
      ]),
      'utf8'
    )
    .digest('hex');
}

export function readIncomingAdmission(
  value: unknown
): IncomingAdmission | IncomingDenied | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || !incomingBounded(value)) return DENIED;
  const descriptors = readIncomingDescriptors(value);
  if (
    !descriptors ||
    'denied' in descriptors ||
    !incomingString(value.id) ||
    !incomingString(value.ref) ||
    !correlation(value.correlation) ||
    !integer(value.eventAt) ||
    !integer(value.admittedAt) ||
    !incomingString(value.senderId) ||
    !incomingString(value.messengerId) ||
    !incomingDigest(value.digest)
  )
    return DENIED;
  // Stored duplicate IDs or truncated descriptors cannot become a different admission.
  if (
    !Array.isArray(value.files) ||
    value.files.length !== descriptors.files.length ||
    value.omitted !== descriptors.omitted
  )
    return DENIED;
  const admission = {
    id: value.id,
    ref: value.ref,
    correlation: value.correlation,
    eventAt: value.eventAt,
    admittedAt: value.admittedAt,
    senderId: value.senderId,
    messengerId: value.messengerId,
    ...descriptors
  };
  if (admissionDigest(admission) !== value.digest) return DENIED;
  return Object.freeze({ ...admission, digest: value.digest });
}

export function readHostIdentity(value: unknown): HostIdentity | undefined {
  if (
    !record(value) ||
    !incomingBounded(value) ||
    value.version !== 1 ||
    !incomingString(value.windowId) ||
    !positive(value.pid) ||
    !positive(value.osStartedAt) ||
    !isStartSource(value.startSource) ||
    !incomingUuid(value.incarnation)
  )
    return undefined;
  return Object.freeze({
    version: 1,
    windowId: value.windowId,
    pid: value.pid,
    osStartedAt: value.osStartedAt,
    startSource: value.startSource,
    incarnation: value.incarnation
  });
}

export function sameHost(a: HostIdentity, b: HostIdentity): boolean {
  return (
    a.version === b.version &&
    a.windowId === b.windowId &&
    a.pid === b.pid &&
    a.osStartedAt === b.osStartedAt &&
    a.startSource === b.startSource &&
    a.incarnation === b.incarnation
  );
}

export function readReceiverIdentity(value: unknown): ReceiverIdentity | undefined {
  if (!record(value) || !incomingBounded(value)) return undefined;
  const host = readHostIdentity(value.host);
  if (
    !host ||
    value.version !== 1 ||
    !positive(value.pid) ||
    !positive(value.osStartedAt) ||
    // One machine, one clock: a receiver read on another clock than its host proves neither.
    value.startSource !== host.startSource ||
    !incomingUuid(value.incarnation) ||
    !isBrand(value.brand) ||
    !incomingPath(value.cwd)
  )
    return undefined;
  return Object.freeze({
    version: 1,
    host,
    pid: value.pid,
    osStartedAt: value.osStartedAt,
    startSource: host.startSource,
    incarnation: value.incarnation,
    brand: value.brand,
    cwd: value.cwd
  });
}

export function sameReceiver(a: ReceiverIdentity, b: ReceiverIdentity): boolean {
  return (
    sameHost(a.host, b.host) &&
    a.version === b.version &&
    a.pid === b.pid &&
    a.osStartedAt === b.osStartedAt &&
    a.startSource === b.startSource &&
    a.incarnation === b.incarnation &&
    a.brand === b.brand &&
    a.cwd === b.cwd
  );
}

export function readIncomingHolder(value: unknown): IncomingHolder | undefined {
  if (!record(value) || !incomingBounded(value) || !integer(value.generation)) return undefined;
  const host = readHostIdentity(value.host);
  return host ? Object.freeze({ host, generation: value.generation }) : undefined;
}

export function readLaunchAttempt(value: unknown): LaunchAttempt | undefined {
  if (!record(value) || !incomingBounded(value)) return undefined;
  const host = readHostIdentity(value.host),
    holder = readIncomingHolder(value.holder);
  if (
    value.version !== 1 ||
    !host ||
    !holder ||
    !incomingUuid(value.attemptId) ||
    !incomingString(value.conversation) ||
    !incomingString(value.messageId) ||
    !correlation(value.correlation) ||
    !incomingDigest(value.admissionDigest) ||
    !incomingPath(value.cwd) ||
    !integer(value.createdAt) ||
    (value.selection !== 'catalog' && value.selection !== 'default') ||
    !target(value.target) ||
    (value.selection === 'catalog' &&
      (value.target.brand === undefined || value.target.model === undefined))
  )
    return undefined;
  return Object.freeze({
    version: 1,
    attemptId: value.attemptId,
    conversation: value.conversation,
    messageId: value.messageId,
    correlation: value.correlation,
    admissionDigest: value.admissionDigest,
    host,
    cwd: value.cwd,
    target: Object.freeze({
      ...(value.target.brand === undefined ? {} : { brand: value.target.brand }),
      ...(value.target.model === undefined ? {} : { model: value.target.model }),
      ...(value.target.window === undefined ? {} : { window: value.target.window }),
      ...(value.target.effort === undefined ? {} : { effort: value.target.effort })
    }),
    selection: value.selection,
    holder,
    createdAt: value.createdAt
  });
}

export function readRemoteLaunchEvidence(value: unknown): RemoteLaunchEvidence | undefined {
  if (!record(value) || !incomingBounded(value)) return undefined;
  const attempt = readLaunchAttempt(value.attempt),
    receiver = readReceiverIdentity(value.receiver);
  if (
    value.version !== 1 ||
    !attempt ||
    !receiver ||
    !sameHost(attempt.host, receiver.host) ||
    attempt.cwd !== receiver.cwd ||
    (attempt.target.brand !== undefined && attempt.target.brand !== receiver.brand) ||
    value.marker !== attempt.attemptId ||
    (value.dismissed !== undefined && value.dismissed !== true) ||
    (value.stage !== 'prepared' && value.stage !== 'accepted')
  )
    return undefined;
  return Object.freeze({
    version: 1,
    attempt,
    receiver,
    marker: value.marker,
    stage: value.stage,
    ...(value.dismissed ? { dismissed: true as const } : {})
  });
}

export function sameLaunchAttempt(a: LaunchAttempt, b: LaunchAttempt): boolean {
  return same(a, b);
}

export function readIncomingDelivery(value: unknown): IncomingDelivery | undefined {
  if (!record(value) || !incomingBounded(value)) return undefined;
  const receiver = readReceiverIdentity(value.receiver);
  return value.version === 1 &&
    receiver &&
    correlation(value.correlation) &&
    incomingDigest(value.admissionDigest)
    ? Object.freeze({
        version: 1,
        receiver,
        correlation: value.correlation,
        admissionDigest: value.admissionDigest
      })
    : undefined;
}

export function readIncomingDeliveryEvidence(value: unknown): IncomingDeliveryEvidence | undefined {
  const delivery = readIncomingDelivery(value);
  if (
    !delivery ||
    !record(value) ||
    !integer(value.acceptedAt) ||
    (value.dismissed !== undefined && value.dismissed !== true) ||
    (value.outcome !== 'send' && value.outcome !== 'queued' && value.outcome !== 'person-answer')
  )
    return undefined;
  return Object.freeze({
    ...delivery,
    acceptedAt: value.acceptedAt,
    outcome: value.outcome,
    ...(value.dismissed ? { dismissed: true as const } : {})
  });
}

export function readIncomingAccess(value: unknown): IncomingAccess | undefined {
  if (
    !record(value) ||
    !incomingBounded(value) ||
    value.version !== 1 ||
    !incomingPath(value.localRoot)
  )
    return undefined;
  const host = readHostIdentity(value.host);
  return host ? Object.freeze({ version: 1, host, localRoot: value.localRoot }) : undefined;
}

export function readIncomingEvidenceQuery(value: unknown): IncomingEvidenceQuery | undefined {
  if (!record(value) || !incomingBounded(value)) return undefined;
  if (value.kind === 'receiver') {
    const receiver = readReceiverIdentity(value.receiver);
    return receiver ? Object.freeze({ kind: 'receiver', receiver }) : undefined;
  }
  if (value.kind === 'attempt') {
    const attempt = readLaunchAttempt(value.attempt);
    return attempt ? Object.freeze({ kind: 'attempt', attempt }) : undefined;
  }
  if (value.kind === 'delivery') {
    const delivery = readIncomingDelivery(value.delivery);
    return delivery ? Object.freeze({ kind: 'delivery', delivery }) : undefined;
  }
  return undefined;
}

export function readIncomingEvidence(value: unknown): IncomingEvidence | undefined {
  if (!record(value) || !incomingBounded(value)) return undefined;
  const host = readHostIdentity(value.host),
    receiver = readReceiverIdentity(value.receiver),
    query = readIncomingEvidenceQuery(value.query);
  if (
    value.version !== 1 ||
    !host ||
    !receiver ||
    !query ||
    !sameHost(host, receiver.host) ||
    !incomingUuid(value.challenge) ||
    !incomingString(value.currentSessionId)
  )
    return undefined;
  if (query.kind === 'receiver') {
    return sameReceiver(query.receiver, receiver) &&
      value.launch === undefined &&
      value.delivery === undefined
      ? Object.freeze({
          version: 1,
          challenge: value.challenge,
          host,
          query,
          receiver,
          currentSessionId: value.currentSessionId
        })
      : undefined;
  }
  if (query.kind === 'attempt') {
    const launch = readRemoteLaunchEvidence(value.launch);
    if (
      !launch ||
      !sameLaunchAttempt(launch.attempt, query.attempt) ||
      !sameReceiver(launch.receiver, receiver) ||
      value.delivery !== undefined
    )
      return undefined;
    return Object.freeze({
      version: 1,
      challenge: value.challenge,
      host,
      query,
      receiver,
      currentSessionId: value.currentSessionId,
      launch
    });
  }
  const delivery = readIncomingDeliveryEvidence(value.delivery);
  if (
    !delivery ||
    !sameReceiver(delivery.receiver, receiver) ||
    !sameReceiver(query.delivery.receiver, receiver) ||
    delivery.correlation !== query.delivery.correlation ||
    delivery.admissionDigest !== query.delivery.admissionDigest ||
    value.launch !== undefined
  )
    return undefined;
  return Object.freeze({
    version: 1,
    challenge: value.challenge,
    host,
    query,
    receiver,
    currentSessionId: value.currentSessionId,
    delivery
  });
}

export function readFetchFileIdentity(value: unknown): FetchFileIdentity | undefined {
  if (!record(value) || !incomingBounded(value)) return undefined;
  const holder = readIncomingHolder(value.holder),
    receiver = readReceiverIdentity(value.receiver);
  return holder &&
    receiver &&
    incomingString(value.currentSessionId) &&
    incomingString(value.conversation) &&
    correlation(value.correlation) &&
    incomingString(value.fileId)
    ? Object.freeze({
        holder,
        receiver,
        currentSessionId: value.currentSessionId,
        conversation: value.conversation,
        correlation: value.correlation,
        fileId: value.fileId
      })
    : undefined;
}

export function readFetchFileReply(value: unknown): FetchFileReply | undefined {
  if (
    !record(value) ||
    !incomingBounded(value) ||
    value.version !== 1 ||
    !incomingUuid(value.requestId)
  )
    return undefined;
  const identity = readFetchFileIdentity(value.identity);
  if (!identity) return undefined;
  const base = { version: 1 as const, requestId: value.requestId, identity };
  if (value.kind === 'pending' && value.retryable === true)
    return Object.freeze({ ...base, kind: 'pending', retryable: true });
  if (value.kind === 'refused' && incomingRefusal(value.code))
    return Object.freeze({ ...base, kind: 'refused', code: value.code });
  if (
    value.kind !== 'fetched' ||
    !cacheKey(value.cacheKey) ||
    !integer(value.bytes) ||
    value.bytes > INCOMING_FILE_MAX_BYTES ||
    !incomingPath(value.path) ||
    !incomingPath(value.localRoot) ||
    !positive(value.expiresAt) ||
    !within(value.localRoot, value.path) ||
    (value.name !== undefined && !incomingString(value.name, 512)) ||
    (value.mime !== undefined && !incomingString(value.mime, 128))
  )
    return undefined;
  return Object.freeze({
    ...base,
    kind: 'fetched',
    cacheKey: value.cacheKey,
    bytes: value.bytes,
    path: value.path,
    localRoot: value.localRoot,
    expiresAt: value.expiresAt,
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.mime === undefined ? {} : { mime: value.mime })
  });
}

export function incomingRefusal(value: unknown): value is IncomingRefusal {
  return (
    typeof value === 'string' &&
    (Object.hasOwn(REFUSALS, value) || /^provider-[a-z0-9][a-z0-9-]{0,54}$/.test(value))
  );
}
const REFUSALS: Record<Exclude<IncomingRefusal, `provider-${string}`>, true> = {
  'unknown-message': true,
  'unknown-file': true,
  closed: true,
  'wrong-receiver': true,
  'admission-denied': true,
  'wrong-install': true,
  'unsupported-version': true,
  'unsupported-capability': true,
  'remote-off': true,
  'evidence-unavailable': true,
  'storage-unavailable': true,
  capacity: true,
  'too-large': true,
  timeout: true,
  'invalid-path': true
};

function readFile(value: unknown): IncomingFile | undefined {
  if (
    !record(value) ||
    !incomingString(value.id) ||
    !incomingString(value.source, 2048) ||
    !cacheKey(value.cacheKey)
  )
    return undefined;
  return Object.freeze({
    id: value.id,
    source: value.source,
    cacheKey: value.cacheKey,
    ...(incomingString(value.name, 512) ? { name: value.name } : {}),
    ...(incomingString(value.mime, 128) ? { mime: value.mime } : {}),
    ...(integer(value.size) ? { size: value.size } : {})
  });
}
function target(value: unknown): value is LaunchTarget {
  return (
    record(value) &&
    (value.brand === undefined || isBrand(value.brand)) &&
    (value.model === undefined || incomingString(value.model)) &&
    (value.window === undefined || positive(value.window)) &&
    (value.effort === undefined || incomingString(value.effort)) &&
    Object.keys(value).every((key) => ['brand', 'model', 'window', 'effort'].includes(key))
  );
}
function cacheKey(value: unknown): value is string {
  return incomingString(value) && /^[A-Za-z0-9_-]+$/.test(value);
}
function correlation(value: unknown): value is string {
  return isCorrelation(value) && incomingString(value, 128);
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function positive(value: unknown): value is number {
  return integer(value) && value > 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  return (
    record(a) &&
    record(b) &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  );
}
/** Only a complete scan using the identity's native source establishes death or PID replacement. */
export function ownerDead(
  owner: Pick<import('./bridge/model').HostIdentity, 'pid' | 'osStartedAt' | 'startSource'>,
  table: Pick<import('./scan').ProcessTable, 'starts' | 'complete' | 'startSource'>
): boolean {
  return (
    table.complete === true &&
    table.startSource === owner.startSource &&
    table.starts.get(owner.pid) !== owner.osStartedAt
  );
}
