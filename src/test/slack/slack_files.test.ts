import * as assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { MaybePosted, type ConversationPlace } from '../../core/bridge/model';
import { REPLY_MS } from '../../core/coordination/requests';
import * as api from '../../core/slack/api';
import * as files from '../../core/slack/files';
import * as fx from '../fixtures/slack_replies';

const TOKEN = 'xoxb-SENTINEL-bot-0000';
const DM = 'D0DM00001';
const P1 = `${DM}:1760000000.000100`;
const PLACE: ConversationPlace = { conversation: { anchor: P1, latest: P1 } };
const UPLOAD_URL = 'https://files.slack.com/upload/v1/fixture-upload';

type Call = { url: string; headers: Record<string, string>; body: string | Uint8Array };

/** A `fetch` for both halves: the Web API answers from `api`, and the upload
 *  URL answers `upload`. Every call is recorded. */
function slack(answers: { api?: (method: string) => unknown; upload?: number } = {}): {
  fetch: api.Fetch & files.UploadFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch = (
    url: string,
    init: { headers: Record<string, string>; body: string | Uint8Array }
  ) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const method = url.replace('https://slack.com/api/', '');
    const json = url === UPLOAD_URL ? undefined : (answers.api?.(method) ?? defaults(method));
    return Promise.resolve({
      status: url === UPLOAD_URL ? (answers.upload ?? 200) : 200,
      headers: { get: () => null },
      json: () => Promise.resolve(json)
    });
  };
  return { fetch, calls };
}

function defaults(method: string): unknown {
  switch (method) {
    case 'files.getUploadURLExternal':
      return fx.uploadUrl();
    case 'files.completeUploadExternal':
      return fx.completeUpload();
    default:
      return fx.error('unknown_method');
  }
}

function methods(calls: readonly Call[]): string[] {
  return calls.map((call) => call.url.replace('https://slack.com/api/', ''));
}

async function rejection(promise: Promise<unknown>): Promise<api.SlackError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof api.SlackError, `not a SlackError: ${String(error)}`);
    return error;
  }
  assert.fail('expected a rejection');
}

describe('uploadFile', () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];
  const attachment = () => ({ bytes: Buffer.from(PNG), name: 'shot.png', mime: 'image/png' });

  it('asks for a URL, sends the bytes there, and shares the file into the thread', async () => {
    const { fetch, calls } = slack();
    const posted = await files.uploadFile(api.slackApi(fetch, TOKEN), fetch, PLACE, attachment());
    assert.deepEqual(methods(calls), [
      'files.getUploadURLExternal',
      UPLOAD_URL,
      'files.completeUploadExternal'
    ]);
    assert.equal(calls[0]?.body, 'filename=shot.png&length=7');
    assert.deepEqual([...(calls[1]?.body as Uint8Array)], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    assert.deepEqual(JSON.parse(calls[2]?.body as string), {
      files: [{ id: 'F0FILE0002', title: 'shot.png' }],
      channel_id: DM,
      thread_ts: '1760000000.000100'
    });
    assert.deepEqual(posted, { message: P1, anchor: P1 });
  });

  it('never sends the bot token to the upload URL', async () => {
    const { fetch, calls } = slack();
    await files.uploadFile(api.slackApi(fetch, TOKEN), fetch, PLACE, attachment());
    const upload = calls.find((call) => call.url === UPLOAD_URL);
    assert.ok(upload);
    assert.ok(!JSON.stringify(upload.headers).includes(TOKEN));
    assert.equal(
      Object.keys(upload.headers).some((name) => name.toLowerCase() === 'authorization'),
      false
    );
  });

  it("sends the caption as the file's comment, with Slack's tokens as literal text", async () => {
    const { fetch, calls } = slack();
    await files.uploadFile(api.slackApi(fetch, TOKEN), fetch, PLACE, {
      ...attachment(),
      caption: 'For <!channel> and <@U0OTHER01> & co'
    });
    const complete = JSON.parse(calls[2]?.body as string) as Record<string, unknown>;
    assert.equal(complete.initial_comment, 'For &lt;!channel&gt; and &lt;@U0OTHER01&gt; &amp; co');
  });

  it('rejects naming the URL call when Slack refuses it, and goes no further', async () => {
    const { fetch, calls } = slack({
      api: (method) =>
        method === 'files.getUploadURLExternal' ? fx.error('invalid_auth') : undefined
    });
    const error = await rejection(
      files.uploadFile(api.slackApi(fetch, TOKEN), fetch, PLACE, attachment())
    );
    assert.equal(error.message, 'files.getUploadURLExternal: invalid_auth');
    assert.equal(calls.length, 1);
  });

  it('rejects naming the upload when the bytes are refused, and shares nothing', async () => {
    const { fetch, calls } = slack({ upload: 500 });
    const error = await rejection(
      files.uploadFile(api.slackApi(fetch, TOKEN), fetch, PLACE, attachment())
    );
    assert.equal(error.message, 'upload: http_500');
    assert.equal(calls.length, 2);
  });

  it('rejects naming the share when Slack refuses it', async () => {
    const { fetch } = slack({
      api: (method) =>
        method === 'files.completeUploadExternal' ? fx.error('channel_not_found') : undefined
    });
    const error = await rejection(
      files.uploadFile(api.slackApi(fetch, TOKEN), fetch, PLACE, attachment())
    );
    assert.equal(error.message, 'files.completeUploadExternal: channel_not_found');
  });

  /** The upload with the share's reply replaced by `share`. */
  function sharing(share: () => Promise<{ status: number; json(): Promise<unknown> }>) {
    const { fetch: plain } = slack();
    const fetch = (
      url: string,
      init: { headers: Record<string, string>; body: string | Uint8Array }
    ) =>
      url.endsWith('files.completeUploadExternal')
        ? share().then((reply) => ({ ...reply, headers: { get: () => null } }))
        : (plain as api.Fetch)(url, init as api.FetchInit);
    return files.uploadFile(api.slackApi(fetch, TOKEN), fetch, PLACE, attachment());
  }

  for (const [what, share] of [
    [
      'an unreadable reply',
      () => Promise.resolve({ status: 200, json: () => Promise.reject(new SyntaxError('cut')) })
    ],
    ['no reply at all', () => Promise.reject(new Error('socket hang up'))],
    ['a gateway error', () => Promise.resolve({ status: 502, json: () => Promise.resolve({}) })]
  ] as const) {
    it(`says the share may have posted after ${what}`, async () => {
      await assert.rejects(sharing(share), (error) => {
        assert.ok(error instanceof MaybePosted, `not MaybePosted: ${String(error)}`);
        assert.match(error.message, /files\.completeUploadExternal/);
        return true;
      });
    });
  }

  /** A `fetch` whose upload URL never answers, and fails only once its
   *  signal aborts, as a half-open connection does. */
  function hanging(): { fetch: api.Fetch & files.UploadFetch; uploading: () => boolean } {
    const answered = slack();
    let uploading = false;
    const fetch = (
      url: string,
      init: { headers: Record<string, string>; body: string | Uint8Array; signal?: AbortSignal }
    ) => {
      if (url !== UPLOAD_URL) return answered.fetch(url, init as never);
      uploading = true;
      return new Promise<never>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    };
    return { fetch, uploading: () => uploading };
  }

  async function started(uploading: () => boolean): Promise<void> {
    for (let spin = 0; spin < 200 && !uploading(); spin++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(uploading(), 'the upload never began');
  }

  it('gives up on the whole upload before the shim gives up on the holder, with room for the holder around it', () => {
    assert.ok(files.UPLOAD_MS + 15_000 <= REPLY_MS.attach);
  });

  it('gives up on an upload that never answers after UPLOAD_MS', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { fetch, uploading } = hanging();
      const sent = files.uploadFile(api.slackApi(fetch, TOKEN), fetch, PLACE, attachment());
      await started(uploading);
      mock.timers.tick(files.UPLOAD_MS);
      const error = await rejection(sent);
      assert.equal(error.code, 'timed_out');
    } finally {
      mock.timers.reset();
    }
  });

  /** A `fetch` where each call answers after its own `ms`, every one inside
   *  its own limit, and fails once its signal aborts. */
  function paced(ms: { url: number; bytes: number; share: number }): api.Fetch & files.UploadFetch {
    const reply: api.Fetch = slack().fetch;
    return (
      url: string,
      init: { headers: Record<string, string>; body: string | Uint8Array; signal?: AbortSignal }
    ): Promise<api.FetchReply> => {
      const after = url === UPLOAD_URL ? ms.bytes : url.endsWith('Upload') ? ms.share : ms.url;
      const due = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, after);
        init.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true }
        );
      });
      return due.then(() => reply(url, init as never));
    };
  }

  for (const [stage, ms, outcome] of [
    ['the bytes', { url: 20_000, bytes: 40_000, share: 10_000 }, 'timed_out'],
    ['the share', { url: 5_000, bytes: 35_000, share: 10_000 }, 'maybe']
  ] as const) {
    it(`gives up on the three calls together at UPLOAD_MS, cut in ${stage}`, async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const fetch = paced(ms);
        let settled: unknown;
        files.uploadFile(api.slackApi(fetch, TOKEN), fetch, PLACE, attachment()).then(
          (posted) => (settled = posted),
          (error: unknown) => (settled = error)
        );
        for (let at = 0; at < files.UPLOAD_MS; at += 1_000) {
          mock.timers.tick(1_000);
          for (let spin = 0; spin < 20; spin++) await new Promise((r) => setImmediate(r));
        }
        if (outcome === 'maybe') {
          assert.ok(settled instanceof MaybePosted, `not MaybePosted: ${String(settled)}`);
        } else {
          assert.ok(settled instanceof api.SlackError, `not a SlackError: ${String(settled)}`);
          assert.equal(settled.code, outcome);
        }
      } finally {
        mock.timers.reset();
      }
    });
  }

  it('gives up on an upload when the caller aborts, as a connection closing does', async () => {
    const { fetch, uploading } = hanging();
    const lifetime = new AbortController();
    const sent = files.uploadFile(
      api.slackApi(fetch, TOKEN),
      fetch,
      PLACE,
      attachment(),
      lifetime.signal
    );
    await started(uploading);
    lifetime.abort();
    const error = await rejection(sent);
    assert.equal(error.code, 'closed');
  });

  it('refuses a place whose anchor is not a Slack ref', async () => {
    const { fetch, calls } = slack();
    const error = await rejection(
      files.uploadFile(
        api.slackApi(fetch, TOKEN),
        fetch,
        { conversation: { anchor: 'nope', latest: 'nope' } },
        attachment()
      )
    );
    assert.equal(error.code, 'bad_place');
    assert.deepEqual(calls, []);
  });
});
