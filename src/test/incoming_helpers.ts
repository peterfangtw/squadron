import * as path from 'node:path';
import type {
  HostIdentity,
  IncomingAdmission,
  IncomingDelivery,
  LaunchAttempt,
  ReceiverIdentity,
  RemoteLaunchEvidence,
  FetchFileIdentity
} from '../core/bridge/model';

export const UUID = '11111111-1111-4111-8111-111111111111';
export const OTHER_UUID = '22222222-2222-4222-8222-222222222222';
export const DIGEST = 'a'.repeat(64);
export const host: HostIdentity = {
  version: 1,
  windowId: 'w1',
  pid: 100,
  osStartedAt: 1000,
  startSource: 'ps-lstart-v1',
  incarnation: UUID
};
export const holder = { host: { ...host, windowId: 'w0', pid: 200 }, generation: 1 };
export const receiver: ReceiverIdentity = {
  version: 1,
  host,
  pid: 7,
  osStartedAt: 2000,
  startSource: 'ps-lstart-v1',
  incarnation: OTHER_UUID,
  brand: 'codex',
  cwd: path.resolve('/work/app')
};
export const attempt: LaunchAttempt = {
  version: 1,
  attemptId: UUID,
  conversation: 'conversation',
  messageId: 'message',
  correlation: 'correlation',
  admissionDigest: DIGEST,
  host,
  cwd: receiver.cwd,
  target: { brand: 'codex', model: 'luna', effort: 'low' },
  selection: 'catalog',
  holder,
  createdAt: 3000
};
export const launch: RemoteLaunchEvidence = {
  version: 1,
  attempt,
  receiver,
  marker: UUID,
  stage: 'accepted'
};
export const delivery: IncomingDelivery = {
  version: 1,
  receiver,
  correlation: 'correlation',
  admissionDigest: DIGEST
};
export const fetchIdentity: FetchFileIdentity = {
  holder,
  receiver,
  currentSessionId: 'current',
  conversation: 'conversation',
  correlation: 'correlation',
  fileId: 'file'
};
export const admission: Omit<IncomingAdmission, 'digest'> = {
  version: 1,
  id: 'message',
  ref: 'ref',
  correlation: 'correlation',
  eventAt: 1000,
  admittedAt: 2000,
  senderId: 'sender',
  messengerId: 'provider',
  installId: 'install',
  files: [{ id: 'file', source: 'opaque:install:file', cacheKey: 'provider_file' }],
  omitted: 0
};
