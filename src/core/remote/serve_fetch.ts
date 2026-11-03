import type { FetchFileIdentity, FetchFileReply } from '../bridge/model';
import type { Reply, Request } from '../coordination/requests';

/** Holder dispatch precedes owned PID routing; authorization is the service's responsibility. */
export async function serveFetchFile(
  request: Extract<Request, { kind: 'fetchFile' }>,
  holder?: {
    fetch(request: { requestId: string; identity: FetchFileIdentity }): Promise<FetchFileReply>;
  }
): Promise<Reply> {
  const {
    kind: _kind,
    version: _version,
    windowId: _window,
    id,
    createdAt: _at,
    ...identity
  } = request;
  const fetchFile: FetchFileReply = holder
    ? await holder.fetch({ requestId: id, identity })
    : { version: 1, requestId: id, identity, kind: 'refused', code: 'remote-off' };
  return { ok: fetchFile.kind === 'fetched', fetchFile };
}
