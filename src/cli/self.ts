import { sessionBrand } from '../core/brands';
import { askExit } from '../core/coordination/ask';
import * as crypto from 'crypto';
import * as incoming from '../core/incoming';
import * as requests from '../core/coordination/requests';
import * as claims from '../core/coordination/claims';
import * as published from '../core/published';
import * as scan from '../core/scan';
import * as identity from '../core/identity';
import type { ReceiverIdentity } from '../core/bridge/model';
import { isStartSource } from '../core/platform/processes';

export type OwnedSelf =
  | { ok: true; receiver: ReceiverIdentity; currentSessionId: string; table: scan.ProcessTable }
  | { ok: false; code: 2 | 3 | 4 | 5; reason: string };

export function nearestOwnedReceiver(
  pid: number,
  table: scan.ProcessTable,
  records: ReadonlyMap<number, published.PublishedLive>
): ReceiverIdentity | undefined {
  if (!table.complete || !isStartSource(table.startSource)) return undefined;
  const visited = new Set<number>();
  for (let depth = 0; depth < 128; depth++) {
    const start = table.starts.get(pid);
    const parent = table.parents.get(pid);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      visited.has(pid) ||
      start === undefined ||
      !Number.isSafeInteger(start) ||
      start <= 0 ||
      parent === undefined
    )
      return undefined;
    visited.add(pid);
    const record = records.get(pid);
    if (record || table.claude.has(pid) || table.grok.has(pid) || table.codex.has(pid)) {
      const receiver = incoming.readReceiverIdentity(record?.receiverIdentity);
      return receiver &&
        record?.session.source === 'owned' &&
        !record.exit &&
        !record.session.background &&
        receiver.startSource === table.startSource &&
        receiver.pid === pid &&
        receiver.osStartedAt === start &&
        record.session.windowId === receiver.host.windowId &&
        sessionBrand(record.session.brand) === receiver.brand &&
        record.session.cwd === receiver.cwd &&
        parent === receiver.host.pid &&
        table.starts.get(parent) === receiver.host.osStartedAt
        ? receiver
        : undefined;
    }
    const parentStart = table.starts.get(parent);
    if (parentStart === undefined || parentStart > start) return undefined;
    pid = parent;
  }
  return undefined;
}

export async function resolveOwnedSelf(): Promise<OwnedSelf> {
  const [table, records, windows] = await Promise.all([
    scan.scanProcesses(true),
    published.readPublished(),
    claims.readClaims()
  ]);
  if (!windows.length)
    return { ok: false, code: 3, reason: 'no IDE window is running with Squadron installed' };
  const receiver = nearestOwnedReceiver(process.pid, table, records);
  if (!receiver)
    return { ok: false, code: 2, reason: 'cannot prove the nearest owned CLI ancestor' };
  const challenge = crypto.randomUUID();
  const file = await requests.postRequest({
    kind: 'incomingEvidenceV1',
    version: 1,
    windowId: receiver.host.windowId,
    expectedHost: receiver.host,
    challenge,
    query: { kind: 'receiver', receiver }
  });
  if (!file)
    return {
      ok: false,
      code: askExit({ kind: 'unwritable' }),
      reason: 'could not submit the receiver challenge'
    };
  const { reply, invalid } = await requests.awaitReplyDetailed(
    file,
    requests.REPLY_MS.incomingEvidenceV1
  );
  if (invalid)
    return {
      ok: false,
      code: askExit({ kind: 'unexpected' }),
      reason: 'the owning window returned malformed receiver evidence'
    };
  if (!reply)
    return {
      ok: false,
      code: askExit({ kind: 'silent' }),
      reason: 'the owning window did not answer the receiver challenge; retry'
    };
  const proof = incoming.readIncomingEvidence(reply.incomingEvidence);
  if (
    !reply.ok ||
    !proof ||
    proof.challenge !== challenge ||
    proof.query.kind !== 'receiver' ||
    !incoming.sameReceiver(proof.receiver, receiver) ||
    !incoming.sameHost(proof.host, receiver.host)
  )
    return {
      ok: false,
      code: askExit({ kind: 'refused', reply }),
      reason: 'the owning window refused exact receiver evidence'
    };
  const spelling = identity.IDENTITY_ENV[receiver.brand];
  const hint = process.env[spelling.id];
  const pidHint = spelling.pid === undefined ? undefined : process.env[spelling.pid];
  if ((hint && hint !== proof.currentSessionId) || (pidHint && pidHint !== String(receiver.pid)))
    return {
      ok: false,
      code: 2,
      reason: 'the tool environment is stale or inherited; retry from the current session'
    };
  return { ok: true, receiver, currentSessionId: proof.currentSessionId, table };
}
