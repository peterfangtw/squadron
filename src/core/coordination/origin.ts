import type { Request, RequestBody } from './requests';

/** Classification only. Caller, holder and receiver proof remain independent. */
export type RequestOrigin = 'agent' | 'composer' | 'remote';

type Of<K extends Request['kind']> = Extract<Request, { kind: K }>;

type Classified<P extends string, R> = { [K in P]: { policy: K; request: R } }[P];

/**
 * Each policy selects one existing admission owner, including its recording and
 * counting contract. Send/Answer serialize accepted actions; agent starts supply
 * requestId for lineage/fleet. Attach reserves independently; no shared counter.
 * Wait is a local host operation, never a request-file origin; Warm is a
 * fixed-kind request like rename and carries none.
 */
export type ClassifiedRequest =
  | Classified<'agent-spawn', Of<'open'> & { prompt: string }>
  | Classified<'composer-open' | 'remote-open', Of<'open'>>
  | Classified<'agent-send' | 'composer-send' | 'remote-send', Of<'send'>>
  | Classified<'agent-answer', Of<'answer'>>
  | Classified<'remote-interrupt', Of<'interrupt'>>
  | Classified<'remote-deny', Of<'deny'>>
  | Classified<'remote-answer', Of<'personAnswer'>>
  | Classified<'remote-start-files', Of<'remoteStartFilesV1'>>
  | Classified<'evidence', Of<'incomingEvidenceV1'>>
  | Classified<'fetch', Of<'fetchFile'>>
  | Classified<'models', Of<'models'>>
  | Classified<'rename', Of<'rename'>>
  | Classified<'warm', Of<'warm'>>
  | Classified<'close', Of<'close'>>
  | Classified<'attach', Of<'attach'>>
  | Classified<'unknown', never>;

/** Validate new metadata without assigning an origin to legacy inputs. */
export function validOrigin(request: RequestBody, origin: unknown = request.origin): boolean {
  if (origin === undefined) return true;
  switch (request.kind) {
    case 'open':
      if (origin === 'remote') return request.via === 'remote' && holderNamed(request.remote);
      if (request.via !== undefined || request.remote !== undefined) return false;
      return origin === (request.prompt === undefined ? 'composer' : 'agent');
    case 'send':
      if (origin === 'remote') return request.via === undefined && holderNamed(request.remote);
      if (request.remote !== undefined || (request.via !== undefined && request.via !== 'verb'))
        return false;
      return origin === (request.via === 'verb' ? 'agent' : 'composer');
    case 'answer':
      return origin === 'agent';
    case 'interrupt':
    case 'deny':
    case 'personAnswer':
    case 'remoteStartFilesV1':
      return origin === 'remote';
    case 'models':
    case 'rename':
    case 'warm':
    case 'close':
    case 'attach':
    case 'incomingEvidenceV1':
    case 'fetchFile':
      return false;
    default:
      // An unknown future kind must retain its older-build refusal.
      return true;
  }
}

/** The ingress decision; callers carry this value rather than re-reading markers. */
export function classifyRequest(request: Request): ClassifiedRequest | undefined {
  if (!validOrigin(request)) return undefined;
  switch (request.kind) {
    case 'open': {
      const source =
        request.origin ??
        (request.via === 'remote' ? 'remote' : request.prompt === undefined ? 'composer' : 'agent');
      const normalized = { ...request, origin: source };
      if (source === 'remote') return { policy: 'remote-open', request: normalized };
      if (source === 'agent' && request.prompt !== undefined)
        return { policy: 'agent-spawn', request: { ...normalized, prompt: request.prompt } };
      return { policy: 'composer-open', request: normalized };
    }
    case 'send': {
      const source = request.origin ?? (request.via === 'verb' ? 'agent' : 'composer');
      return {
        policy:
          source === 'remote' ? 'remote-send' : source === 'agent' ? 'agent-send' : 'composer-send',
        request: { ...request, origin: source }
      };
    }
    case 'answer':
      return { policy: 'agent-answer', request };
    case 'interrupt':
      return { policy: 'remote-interrupt', request };
    case 'deny':
      return { policy: 'remote-deny', request };
    case 'personAnswer':
      return { policy: 'remote-answer', request };
    case 'remoteStartFilesV1':
      return { policy: 'remote-start-files', request };
    case 'incomingEvidenceV1':
      return { policy: 'evidence', request };
    case 'fetchFile':
      return { policy: 'fetch', request };
    case 'models':
      return { policy: 'models', request };
    case 'rename':
      return { policy: 'rename', request };
    case 'warm':
      return { policy: 'warm', request };
    case 'close':
      return { policy: 'close', request };
    case 'attach':
      return { policy: 'attach', request };
    default:
      request satisfies never;
      return { policy: 'unknown', request };
  }
}

function holderNamed(remote: string | undefined): boolean {
  return typeof remote === 'string' && remote.length > 0;
}
