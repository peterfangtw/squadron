/**
 * A file into a conversation, by Slack's external upload: ask for a URL, send
 * the bytes there, then share the file into the thread. The three calls and a
 * failure between any two are one unit, so a caller hands the bytes and gets a
 * post or a rejection naming the call that failed.
 *
 * Provisional (master R1): the bodies and headers come from Slack's docs for
 * `files.getUploadURLExternal` and `files.completeUploadExternal`, and M1
 * Step 3 checks them on a real workspace.
 */

import { MaybePosted, type Attachment, type ConversationPlace, type Posted } from '../bridge/model';
import * as api from './api';
import * as render from './render';
import * as wire from './wire';

/** The largest file Slack takes, as published: 1 GB. Step 3 has not measured
 *  one; the core sends far less (M3's cap). */
export const FILE_MAX = 1_000_000_000;

/**
 * How long the whole upload may take before it is abandoned (a duration): the
 * URL, the bytes and the share under one deadline, since each call's own
 * limit (`api.CALL_MS`) sums past the shim's wait. A file at M3's cap over the
 * uplink `REPLY_MS.attach` assumes, with 15 s of that wait left for the
 * holder's pass, checks and read before it and its answer after. Unbounded, a
 * half-open upload holds the engine's chain — every inbound event and pass,
 * and turn-off, a rebuild and the holder's release behind them — for as long
 * as the platform's own socket timeout.
 */
export const UPLOAD_MS = 45_000;

/** The slice of `fetch` the upload uses: raw bytes, to the URL Slack handed
 *  out. The global `fetch` fits it. */
export type UploadFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: Uint8Array<ArrayBuffer>;
    signal: AbortSignal;
  }
) => Promise<{ status: number }>;

/**
 * Upload `attachment` into the conversation's thread. The caption is the
 * file's comment, escaped as a notice's head is, so an agent's `<!channel>`
 * arrives as text in a shared channel (D24).
 *
 * Slack's reply names the file and not the message that shares it, which is
 * made after the reply, so `message` is the thread's anchor: a reply in the
 * thread resolves by its anchor alone.
 *
 * `lifetime` is the connection's: closing it abandons the bytes' upload, as it
 * does every Web API call.
 */
export async function uploadFile(
  slack: Pick<api.SlackApi, 'uploadUrl' | 'completeUpload'>,
  fetch: UploadFetch,
  place: ConversationPlace,
  attachment: Attachment,
  lifetime?: AbortSignal
): Promise<Posted> {
  const anchor = place.conversation.anchor;
  const thread = wire.parseRef(anchor);
  if (thread === undefined) {
    throw new api.SlackError(UPLOAD, 'bad_place');
  }
  // A copy over a plain `ArrayBuffer`, which is what `fetch` takes as a body.
  const bytes = new Uint8Array(attachment.bytes);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), UPLOAD_MS);
  const signal = lifetime ? AbortSignal.any([lifetime, deadline.signal]) : deadline.signal;
  // A Web API call the deadline aborted says `closed`, as the lifetime's would.
  const named = (error: unknown) =>
    error instanceof api.SlackError && error.code === 'closed' && !lifetime?.aborted
      ? new api.SlackError(error.method, 'timed_out')
      : error;
  try {
    const { uploadUrl, fileId } = await slack
      .uploadUrl(attachment.name, bytes.length, signal)
      .catch((error: unknown) => {
        throw named(error);
      });
    await send(fetch, uploadUrl, bytes, signal, lifetime);
    try {
      await slack.completeUpload(
        {
          fileId,
          title: attachment.name,
          channel: thread.channel,
          threadTs: thread.ts,
          ...(attachment.caption !== undefined &&
            attachment.caption !== '' && {
              initialComment: render.escapeMrkdwn(attachment.caption)
            })
        },
        signal
      );
    } catch (caught) {
      const error = named(caught);
      // The share is the call that posts: one Slack may have carried out
      // without its answer arriving is not a refusal.
      if (error instanceof api.SlackError && api.unanswered(error.code)) {
        throw new MaybePosted(error.message);
      }
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
  return { message: anchor, anchor };
}

/** What a failure outside the two Web API calls is named, as `SlackError`'s
 *  method. */
const UPLOAD = 'upload';

/** The bytes to the upload URL, with no bearer token: that host is handed a
 *  URL that is its own credential. Abandoned when `signal` aborts: `closed`
 *  when it was `lifetime`, else the upload's deadline. */
async function send(
  fetch: UploadFetch,
  url: string,
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
  lifetime: AbortSignal | undefined
): Promise<void> {
  let status: number;
  try {
    ({ status } = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
      signal
    }));
  } catch {
    // What `fetch` threw names the URL, which is a credential.
    const code = lifetime?.aborted ? 'closed' : signal.aborted ? 'timed_out' : undefined;
    throw new api.SlackError(UPLOAD, code ?? 'request_failed');
  }
  if (status < 200 || status >= 300) {
    throw new api.SlackError(UPLOAD, `http_${status}`);
  }
}
