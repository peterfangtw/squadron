import * as api from './api';
import * as wire from './wire';
import * as incoming from '../incoming';
import type { IncomingFile } from '../bridge/model';
import type { Messenger } from '../bridge/port';

export type BinaryFetch = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    redirect: 'manual';
    signal: AbortSignal;
  }
) => Promise<Pick<Response, 'status' | 'headers' | 'body'>>;

/** Provider deadline, not a Slack limit; the holder's budget may end it earlier. */
const DOWNLOAD_MS = 45_000;
const ORIGIN = 'https://files.slack.com';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CONTENT_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br']);
const KNOWN = new Set([
  'missing_scope',
  'file_not_found',
  'not_found',
  'file_deleted',
  'access_denied',
  'no_permission',
  'not_in_channel',
  'invalid_auth',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'ratelimited',
  'closed',
  'timed_out',
  'unreadable_reply'
]);

class DownloadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function incomingFiles(
  slack: api.SlackApi,
  fetch: BinaryFetch,
  token: string,
  self: wire.Identity,
  lifetime: () => AbortSignal
): NonNullable<Messenger['incomingFiles']> {
  const resolved = new WeakMap<AbortSignal, Map<string, wire.FileInfo>>();
  const valid = (file: IncomingFile): boolean =>
    /^F[A-Z0-9]{1,127}$/.test(file.id) &&
    file.source === wire.fileSource(self, file.id) &&
    file.cacheKey === wire.fileKey(self, file.id);
  const check = (file: IncomingFile, signal: AbortSignal): void => {
    if (signal.aborted || lifetime().aborted) throw new DownloadError('closed');
    if (!valid(file)) throw new DownloadError('wrong-source');
  };
  return {
    version: 1,
    installId: wire.installId(self),
    verify(file, signal) {
      return Promise.resolve(!signal.aborted && !lifetime().aborted && valid(file));
    },
    refusal(error) {
      return `provider-${error instanceof DownloadError ? error.code : 'request-failed'}`;
    },
    async metadata(file, signal) {
      check(file, signal);
      const deadline = AbortSignal.timeout(DOWNLOAD_MS);
      const bounded = AbortSignal.any([signal, lifetime(), deadline]);
      let info: wire.FileInfo;
      try {
        info = await until(slack.fileInfo(file.id, bounded), bounded);
      } catch (error) {
        if (error instanceof DownloadError) throw error;
        if (
          error instanceof api.SlackError &&
          error.code === 'ratelimited' &&
          error.retryAfterSeconds !== undefined
        )
          throw new DownloadError(`ratelimited-retry-${error.retryAfterSeconds}`);
        const code =
          error instanceof api.SlackError && KNOWN.has(error.code)
            ? error.code.replaceAll('_', '-')
            : 'request-failed';
        throw new DownloadError(code);
      }
      check(file, signal);
      if (info.id !== file.id) throw new DownloadError('wrong-file');
      if (info.mode !== 'hosted' || info.external !== false || !info.downloadUrl)
        throw new DownloadError('original-unavailable');
      safeUrl(info.downloadUrl);
      if (info.size !== undefined && info.size > incoming.INCOMING_FILE_MAX_BYTES)
        throw new DownloadError('too-large');
      let operation = resolved.get(signal);
      if (!operation) {
        operation = new Map();
        resolved.set(signal, operation);
        const records = operation;
        signal.addEventListener('abort', () => records.clear(), { once: true });
      }
      if (operation.size >= incoming.INCOMING_MAX_FILES && !operation.has(file.source))
        throw new DownloadError('capacity');
      operation.set(file.source, info);
      const { name, mime, size } = info;
      return {
        ...(name !== undefined && { name }),
        ...(mime !== undefined && { mime }),
        ...(size !== undefined && { size })
      };
    },
    download(file, options) {
      return Promise.resolve().then(() => {
        check(file, options.signal);
        const operation = resolved.get(options.signal);
        const info = operation?.get(file.source);
        operation?.delete(file.source);
        if (!info?.downloadUrl) throw new DownloadError('metadata-required');
        if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
          throw new DownloadError('too-large');
        const maxBytes = Math.min(options.maxBytes, incoming.INCOMING_FILE_MAX_BYTES);
        if (info.size !== undefined && info.size > maxBytes) throw new DownloadError('too-large');
        return original(fetch, token, info, maxBytes, options.signal, lifetime());
      });
    }
  };
}

async function* original(
  fetch: BinaryFetch,
  token: string,
  info: wire.FileInfo,
  maxBytes: number,
  signal: AbortSignal,
  lifetime: AbortSignal
): AsyncGenerator<Uint8Array> {
  const deadline = AbortSignal.timeout(DOWNLOAD_MS);
  const bounded = AbortSignal.any([signal, lifetime, deadline]);
  const url = safeUrl(info.downloadUrl ?? '');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const reply = await originalResponse(fetch, token, url, bounded);
    reader = reply.body?.getReader();
    const { expected, sniff } = originalContent(reply.headers, info.mime, maxBytes);
    let size = 0;
    let prefix = Buffer.alloc(0);
    let sniffed = !sniff;
    while (reader) {
      const chunk = await until(reader.read(), bounded);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes || (expected !== undefined && size > expected))
        throw new DownloadError(size > maxBytes ? 'too-large' : 'invalid-download');
      if (!sniffed) {
        const taken = Math.min(512 - prefix.length, chunk.value.byteLength);
        prefix = Buffer.concat([prefix, chunk.value.subarray(0, taken)]);
        const text = prefix
          .toString('utf8')
          .replace(/^\uFEFF/, '')
          .trimStart();
        if (/^<(?:!doctype\s+html|html|head|body)(?:\s|>)/i.test(text))
          throw new DownloadError('invalid-download');
        if (prefix.length === 512) sniffed = true;
      }
      yield chunk.value;
    }
    if (
      (expected !== undefined && size !== expected) ||
      (info.size !== undefined && size !== info.size)
    )
      throw new DownloadError('invalid-download');
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    throw new DownloadError('request-failed');
  } finally {
    // Cancel releases the network body on early consumer return as well as failure.
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

async function originalResponse(
  fetch: BinaryFetch,
  token: string,
  url: URL,
  bounded: AbortSignal
): ReturnType<BinaryFetch> {
  let redirects = 0;
  let retries = 0;
  for (;;) {
    if (bounded.aborted) throw new DownloadError('closed');
    const pending = fetch(url.href, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity' },
      redirect: 'manual',
      signal: bounded
    });
    void pending
      .then((late) => {
        if (bounded.aborted) void late.body?.cancel().catch(() => {});
      })
      .catch(() => {});
    const reply = await until(pending, bounded);
    if (REDIRECTS.has(reply.status)) {
      void reply.body?.cancel().catch(() => {});
      if (++redirects > 3) throw new DownloadError('unsafe-redirect');
      const location = reply.headers.get('location');
      if (!location) throw new DownloadError('unsafe-redirect');
      try {
        url = safeUrl(new URL(location, url).href);
      } catch {
        throw new DownloadError('unsafe-redirect');
      }
      continue;
    }
    if (reply.status === 429) {
      void reply.body?.cancel().catch(() => {});
      const retry = reply.headers.get('retry-after');
      const seconds = retry !== null && /^\d{1,6}$/.test(retry) ? Number(retry) : 1;
      const ms = seconds * 1000;
      if (++retries > 3) throw new DownloadError(`ratelimited-retry-${seconds}`);
      await retryDelay(ms, bounded);
      continue;
    }
    if (reply.status !== 200) {
      void reply.body?.cancel().catch(() => {});
      throw new DownloadError(
        reply.status === 403
          ? 'access-denied'
          : reply.status === 404
            ? 'file-not-found'
            : 'request-failed'
      );
    }
    return reply;
  }
}

async function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  await until(
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    }),
    signal
  );
}

function originalContent(
  headers: Headers,
  mime: string | undefined,
  maxBytes: number
): { expected: number | undefined; sniff: boolean } {
  const encoding = headers.get('content-encoding')?.trim().toLowerCase() ?? '';
  const identity = encoding === '' || encoding === 'identity';
  if (!identity && !encoding.split(',').every((one) => CONTENT_ENCODINGS.has(one.trim())))
    throw new DownloadError('invalid-download');
  const length = headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) throw new DownloadError('invalid-download');
  const advertised = length === null ? undefined : Number(length);
  if (advertised !== undefined && !Number.isSafeInteger(advertised))
    throw new DownloadError('invalid-download');
  // Node fetch decodes content codings but retains their encoded Content-Length.
  const expected = identity ? advertised : undefined;
  if (expected !== undefined && expected > maxBytes) throw new DownloadError('too-large');
  const originalMime = mime?.split(';')[0]?.trim().toLowerCase();
  const htmlOriginal = originalMime === 'text/html' || originalMime === 'application/xhtml+xml';
  const binaryExpected =
    !!originalMime &&
    !originalMime.endsWith('+json') &&
    (/^(image|audio|video)\//.test(originalMime) ||
      /^application\/(?:pdf|octet-stream|zip|gzip|msword)$/.test(originalMime) ||
      /^application\/vnd\.(?:ms-|openxmlformats-officedocument\.)/.test(originalMime));
  const replyMime = headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (
    (!htmlOriginal && (replyMime === 'text/html' || replyMime === 'application/xhtml+xml')) ||
    (binaryExpected &&
      (replyMime.startsWith('text/') || /^application\/(?:json|[^/]+\+json)$/.test(replyMime)))
  )
    throw new DownloadError('invalid-download');
  return { expected, sniff: binaryExpected };
}

function safeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DownloadError('unsafe-url');
  }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash)
    throw new DownloadError('unsafe-url');
  return url;
}

async function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () =>
      reject(
        new DownloadError(
          signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
            ? 'timeout'
            : 'closed'
        )
      );
  });
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) stop();
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
