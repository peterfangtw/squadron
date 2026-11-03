import * as assert from 'node:assert/strict';
import { it } from 'node:test';
import * as messenger from '../../core/slack/messenger';
import * as inbound from '../../core/slack/inbound';
import * as wire from '../../core/slack/wire';
import type { IncomingFile } from '../../core/bridge/model';
import { CREDENTIALS } from './slack_helpers';

const SELF = { teamId: 'TINSTALL', userId: 'UBOT' };
const FILE: IncomingFile = {
  id: 'FONE',
  source: 'slack:TINSTALL:UBOT:FONE',
  cacheKey: 'slack_TINSTALL_UBOT_FONE'
};

it('maps live and history descriptors to authenticated installation, never uploader team or URLs', () => {
  const raw = {
    type: 'message',
    channel: 'DCHAN',
    ts: '1791772116.528019',
    user: 'USENDER',
    user_team: 'TFOREIGN',
    text: 'read it',
    files: [
      {
        id: 'FONE',
        name: 'one.png',
        mimetype: 'image/png',
        size: 3,
        url_private: 'https://secret',
        user_team: 'TUPLOAD'
      },
      { id: 'FONE', name: 'duplicate' },
      { id: 'FTWO', file_access: 'check_file_info' },
      { id: 'FTHREE', name: '\nunsafe', mimetype: 'x'.repeat(200), size: -1 },
      { id: 'https://secret' }
    ]
  };
  const event = wire.readMessages([raw], 'DCHAN')[0];
  assert.ok(event);
  const mapped = inbound.fromHistory(event, SELF);
  assert.ok(mapped?.kind === 'message');
  assert.deepEqual(mapped.incoming, {
    version: 1,
    installId: 'slack:TINSTALL:UBOT',
    omitted: 0,
    files: [
      { ...FILE, name: 'one.png', mime: 'image/png', size: 3 },
      { id: 'FTWO', source: 'slack:TINSTALL:UBOT:FTWO', cacheKey: 'slack_TINSTALL_UBOT_FTWO' },
      { id: 'FTHREE', source: 'slack:TINSTALL:UBOT:FTHREE', cacheKey: 'slack_TINSTALL_UBOT_FTHREE' }
    ]
  });
  assert.equal(mapped.sender.id, 'TFOREIGN:USENDER');
  const narrowed = wire.narrowEnvelope({
    type: 'events_api',
    envelope_id: 'e',
    payload: { event_id: 'e', team_id: 'TOTHER', event: raw }
  }).envelope;
  assert.ok(narrowed?.type === 'events_api');
  assert.deepEqual(inbound.toInbound(narrowed, SELF)[0], mapped);
  assert.doesNotMatch(JSON.stringify(mapped), /secret|TUPLOAD/);
});

it('caps unique descriptors and preserves empty file-only text and mention parsing', () => {
  for (const type of ['message', 'app_mention']) {
    const narrowed = wire.narrowEnvelope({
      type: 'events_api',
      envelope_id: 'e',
      payload: {
        event_id: 'e',
        team_id: 'TINSTALL',
        event: {
          type,
          channel: 'DCHAN',
          ts: '1.2',
          user: 'USENDER',
          text: type === 'message' ? '' : '<@UBOT>',
          files: Array.from({ length: 12 }, (_, i) => ({ id: `F${i}` }))
        }
      }
    }).envelope;
    assert.ok(narrowed?.type === 'events_api');
    const mapped = inbound.toInbound(narrowed, SELF)[0];
    assert.ok(mapped?.kind === 'message');
    assert.equal(mapped.text, '');
    assert.ok(mapped.incoming && 'files' in mapped.incoming);
    assert.equal(mapped.incoming.files.length, 10);
    assert.equal(mapped.incoming.omitted, 2);
  }
});

it('authenticates before composing provider and streams exact bytes without leaking originals', async (t) => {
  const requests: { url: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith('/auth.test'))
      return Promise.resolve(Response.json({ ok: true, team_id: 'TINSTALL', user_id: 'UBOT' }));
    if (url.endsWith('/files.info'))
      return Promise.resolve(
        Response.json({
          ok: true,
          file: {
            id: 'FONE',
            mode: 'hosted',
            is_external: false,
            name: 'one.png',
            mimetype: 'image/png',
            size: 3,
            url_private_download: 'https://files.slack.com/original'
          }
        })
      );
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Length': '3', 'Content-Type': 'image/png' }
      })
    );
  });
  const created = await messenger.slackEntry.create(CREDENTIALS);
  assert.ok(created.ok);
  const provider = created.messenger.incomingFiles;
  assert.ok(provider);
  assert.equal(provider.installId, 'slack:TINSTALL:UBOT');
  const signal = new AbortController().signal;
  assert.equal(await provider.verify(FILE, signal), true);
  assert.deepEqual(await provider.metadata(FILE, signal), {
    name: 'one.png',
    mime: 'image/png',
    size: 3
  });
  const chunks = [];
  for await (const chunk of await provider.download(FILE, { signal, maxBytes: 10 }))
    chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3]));
  assert.deepEqual(
    requests.map((r) => r.url),
    [
      'https://slack.com/api/auth.test',
      'https://slack.com/api/files.info',
      'https://files.slack.com/original'
    ]
  );
  assert.equal(requests[2]?.init?.redirect, 'manual');
  assert.equal(
    (requests[2]?.init?.headers as Record<string, string>).Authorization,
    `Bearer ${CREDENTIALS.botToken}`
  );
  created.messenger.close();
});

type Scenario = {
  info?: Record<string, unknown>;
  reply?: (n: number, signal: AbortSignal) => Response | Promise<Response>;
};

async function providerRig(t: import('node:test').TestContext, scenario: Scenario = {}) {
  const gets: { url: string; headers: HeadersInit | undefined }[] = [];
  const infos: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/auth.test'))
      return Response.json({ ok: true, team_id: 'TINSTALL', user_id: 'UBOT' });
    if (url.endsWith('/files.info')) {
      const id = new URLSearchParams(init.body as string).get('file');
      infos.push(id ?? '');
      return Response.json({
        ok: true,
        file: {
          id,
          mode: 'hosted',
          is_external: false,
          name: 'original',
          mimetype: 'application/octet-stream',
          url_private_download: 'https://files.slack.com/original',
          ...scenario.info
        }
      });
    }
    gets.push({ url, headers: init.headers });
    return scenario.reply
      ? scenario.reply(gets.length, init.signal as AbortSignal)
      : new Response(new Uint8Array([1, 2, 3]));
  });
  const created = await messenger.slackEntry.create(CREDENTIALS);
  assert.ok(created.ok);
  t.after(() => created.messenger.close());
  const provider = created.messenger.incomingFiles;
  assert.ok(provider);
  async function bytes(file = FILE, signal = new AbortController().signal, maxBytes = 10) {
    await provider!.metadata(file, signal);
    const chunks: Uint8Array[] = [];
    for await (const chunk of await provider!.download(file, { signal, maxBytes }))
      chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  return { provider, gets, infos, bytes, messenger: created.messenger };
}

it('rejects wrong installation, source and key before file-info requests', async (t) => {
  const r = await providerRig(t);
  for (const file of [
    { ...FILE, source: 'slack:TOTHER:UBOT:FONE' },
    { ...FILE, source: 'https://files.slack.com/original' },
    { ...FILE, id: 'FTWO' },
    { ...FILE, cacheKey: 'slack_TINSTALL_UOTHER_FONE' }
  ]) {
    assert.equal(await r.provider.verify(file, new AbortController().signal), false);
    await assert.rejects(
      r.bytes(file),
      (error: unknown) => r.provider.refusal(error) === 'provider-wrong-source'
    );
  }
  assert.deepEqual(r.infos, []);
  assert.deepEqual(r.gets, []);
});

it('requires exact fresh info ID and hosted originals and never visits third-party content', async (t) => {
  for (const info of [
    { id: 'FTWO' },
    { mode: 'snippet' },
    { mode: 'post' },
    { mode: 'external', is_external: true },
    { is_external: true },
    { url_private_download: undefined }
  ]) {
    await t.test(JSON.stringify(info), async (one) => {
      const r = await providerRig(one, { info });
      await assert.rejects(r.bytes());
      assert.equal(r.gets.length, 0);
    });
  }
});

it('streams valid zero-byte originals and preserves ordinary HTML, XHTML and plain-text source', async (t) => {
  for (const mime of ['text/html', 'application/xhtml+xml', 'text/plain']) {
    await t.test(mime, async (one) => {
      const original = '<html>ordinary original</html>';
      const r = await providerRig(one, {
        info: { mimetype: mime, size: Buffer.byteLength(original) },
        reply: () => new Response(original, { headers: { 'content-type': mime } })
      });
      assert.equal((await r.bytes(FILE, undefined, 100)).toString(), original);
    });
  }
  await t.test('empty original', async (one) => {
    const r = await providerRig(one, {
      info: { size: 0 },
      reply: () => new Response(null, { headers: { 'content-length': '0' } })
    });
    assert.equal((await r.bytes()).length, 0);
  });
});

it('enforces streaming cap without length and refuses false, oversized and truncated lengths', async (t) => {
  const cases: { headers: Record<string, string>; body: number[]; max: number; code: string }[] = [
    { headers: {}, body: [1, 2, 3, 4], max: 3, code: 'too-large' },
    { headers: { 'content-length': '1' }, body: [1, 2, 3], max: 10, code: 'invalid-download' },
    { headers: { 'content-length': '11' }, body: [1], max: 10, code: 'too-large' },
    { headers: { 'content-length': '4' }, body: [1, 2, 3], max: 10, code: 'invalid-download' },
    { headers: { 'content-length': 'lie' }, body: [1], max: 10, code: 'invalid-download' }
  ];
  for (const one of cases) {
    await t.test(one.code + JSON.stringify(one.headers), async (test) => {
      const r = await providerRig(test, {
        reply: () => new Response(new Uint8Array(one.body), { headers: one.headers })
      });
      await assert.rejects(
        r.bytes(FILE, undefined, one.max),
        (error: unknown) => r.provider.refusal(error) === `provider-${one.code}`
      );
    });
  }
});

it('rejects login and preview HTML contradictory to image originals including split body prefixes', async (t) => {
  for (const header of ['text/html', 'image/png']) {
    await t.test(header, async (one) => {
      const r = await providerRig(one, {
        info: { mimetype: 'image/png' },
        reply: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('<!doc'));
                controller.enqueue(new TextEncoder().encode('type html><html>login</html>'));
                controller.close();
              }
            }),
            { headers: { 'content-type': header } }
          )
      });
      await assert.rejects(
        r.bytes(FILE, undefined, 100),
        (error: unknown) => r.provider.refusal(error) === 'provider-invalid-download'
      );
    });
  }
});

it('refuses unsafe original and redirect URLs before bearer can reach another origin', async (t) => {
  for (const url of [
    'http://files.slack.com/a',
    'https://user:pass@files.slack.com/a',
    'https://127.0.0.1/a',
    'https://files.slack.com.evil/a',
    'https://files.slack.com:444/a'
  ]) {
    await t.test(url, async (one) => {
      const r = await providerRig(one, { info: { url_private_download: url } });
      await assert.rejects(r.bytes());
      assert.equal(r.gets.length, 0);
    });
    await t.test('redirect ' + url, async (one) => {
      const r = await providerRig(one, {
        reply: () => new Response(null, { status: 302, headers: { location: url } })
      });
      await assert.rejects(
        r.bytes(),
        (error: unknown) => r.provider.refusal(error) === 'provider-unsafe-redirect'
      );
      assert.deepEqual(
        r.gets.map((get) => get.url),
        ['https://files.slack.com/original']
      );
    });
  }
});

it('follows finite same-origin redirects with bearer and refuses loops', async (t) => {
  const r = await providerRig(t, {
    reply: (n) =>
      n === 1
        ? new Response(
            new ReadableStream({
              cancel() {
                return new Promise<void>(() => {});
              }
            }),
            { status: 302, headers: { location: '/second' } }
          )
        : new Response(new Uint8Array([1]))
  });
  assert.deepEqual(await r.bytes(), Buffer.from([1]));
  assert.deepEqual(
    r.gets.map((get) => get.url),
    ['https://files.slack.com/original', 'https://files.slack.com/second']
  );
  for (const get of r.gets)
    assert.equal(
      (get.headers as Record<string, string>).Authorization,
      `Bearer ${CREDENTIALS.botToken}`
    );
  await t.test('loop', async (one) => {
    const loop = await providerRig(one, {
      reply: () => new Response(null, { status: 302, headers: { location: '/loop' } })
    });
    await assert.rejects(loop.bytes());
    assert.equal(loop.gets.length, 4);
  });
});

it('isolates simultaneous metadata and consumes it once per operation', async (t) => {
  const r = await providerRig(t);
  const a = new AbortController();
  const b = new AbortController();
  await r.provider.metadata(FILE, a.signal);
  await r.provider.metadata(FILE, b.signal);
  a.abort();
  await assert.rejects(r.provider.download(FILE, { signal: a.signal, maxBytes: 10 }));
  const chunks = [];
  for await (const chunk of await r.provider.download(FILE, { signal: b.signal, maxBytes: 10 }))
    chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3]));
  await assert.rejects(r.provider.download(FILE, { signal: b.signal, maxBytes: 10 }));
  assert.equal(r.infos.length, 2);
});

it('cancels stalled bodies and late response bodies without waiting for their cancellation', async (t) => {
  let cancelled = 0;
  const r = await providerRig(t, {
    reply: () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise<void>(() => {});
          },
          cancel() {
            cancelled++;
            return new Promise<void>(() => {});
          }
        })
      )
  });
  const abort = new AbortController();
  const pending = r.bytes(FILE, abort.signal);
  while (!r.gets.length) await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(
    pending,
    (error: unknown) => r.provider.refusal(error) === 'provider-closed'
  );
  assert.equal(cancelled, 1);
  await t.test('consumer returns after one chunk', async (one) => {
    let returnedCancelled = 0;
    const first = new Uint8Array([1, 2, 3]);
    const returned = await providerRig(one, {
      reply: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(first);
            },
            pull() {
              return new Promise<void>(() => {});
            },
            cancel() {
              returnedCancelled++;
              return new Promise<void>(() => {});
            }
          })
        )
    });
    const signal = new AbortController().signal;
    await returned.provider.metadata(FILE, signal);
    for await (const chunk of await returned.provider.download(FILE, { signal, maxBytes: 10 })) {
      assert.deepEqual(chunk, first);
      break;
    }
    assert.equal(returnedCancelled, 1);
  });
  await t.test('late headers', async (one) => {
    let deliver: (reply: Response) => void = () => {};
    let lateCancelled = 0;
    const late = await providerRig(one, {
      reply: () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        })
    });
    const stop = new AbortController();
    const downloading = late.bytes(FILE, stop.signal);
    while (!late.gets.length) await new Promise<void>((resolve) => setImmediate(resolve));
    stop.abort();
    await assert.rejects(downloading);
    deliver(
      new Response(
        new ReadableStream({
          cancel() {
            lateCancelled++;
          }
        })
      )
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(lateCancelled, 1);
  });
});

it('bounds rate-limit retries and reports sanitized retry seconds while honoring cancellation', async (t) => {
  const r = await providerRig(t, {
    reply: () => new Response(null, { status: 429, headers: { 'retry-after': '0' } })
  });
  await assert.rejects(
    r.bytes(),
    (error: unknown) => r.provider.refusal(error) === 'provider-ratelimited-retry-0'
  );
  assert.equal(r.gets.length, 4);
  await t.test('cancel long retry', async (one) => {
    const limited = await providerRig(one, {
      reply: () => new Response(null, { status: 429, headers: { 'retry-after': '60' } })
    });
    const stop = new AbortController();
    const work = limited.bytes(FILE, stop.signal);
    while (!limited.gets.length) await new Promise<void>((resolve) => setImmediate(resolve));
    stop.abort();
    await assert.rejects(work);
    assert.equal(limited.gets.length, 1);
  });
});

it('sanitizes metadata errors and aborts authenticated bootstrap before exposing a messenger', async (t) => {
  t.mock.method(globalThis, 'fetch', (url: string) =>
    Promise.resolve(
      Response.json(
        url.endsWith('/auth.test')
          ? { ok: true, team_id: 'TINSTALL', user_id: 'UBOT' }
          : { ok: false, error: 'https://private/SENTINEL' }
      )
    )
  );
  const created = await messenger.slackEntry.create(CREDENTIALS);
  assert.ok(created.ok && created.messenger.incomingFiles);
  const provider = created.messenger.incomingFiles;
  await assert.rejects(provider.metadata(FILE, new AbortController().signal), (error: unknown) => {
    assert.equal(provider.refusal(error), 'provider-request-failed');
    assert.doesNotMatch(String(error), /private|SENTINEL/);
    return true;
  });
  created.messenger.close();
  await t.test('construction cancellation', async (one) => {
    let started: () => void = () => {};
    const called = new Promise<void>((resolve) => {
      started = resolve;
    });
    one.mock.method(globalThis, 'fetch', () => {
      started();
      return new Promise<Response>(() => {});
    });
    const stop = new AbortController();
    const building = messenger.slackEntry.create(CREDENTIALS, stop.signal);
    await called;
    stop.abort();
    const result = await building;
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL|https:/);
  });
});

it('an older install missing read scope still posts text and gives a named file refusal', async (t) => {
  const methods: string[] = [];
  t.mock.method(globalThis, 'fetch', (url: string) => {
    const method = url.split('/').at(-1) ?? '';
    methods.push(method);
    return Promise.resolve(
      Response.json(
        method === 'auth.test'
          ? { ok: true, team_id: 'TINSTALL', user_id: 'UBOT' }
          : method === 'files.info'
            ? { ok: false, error: 'missing_scope' }
            : { ok: true, channel: 'DCHAN', ts: '1.2' }
      )
    );
  });
  const created = await messenger.slackEntry.create(CREDENTIALS);
  assert.ok(created.ok && created.messenger.incomingFiles);
  const provider = created.messenger.incomingFiles;
  await assert.rejects(
    provider.metadata(FILE, new AbortController().signal),
    (error: unknown) => provider.refusal(error) === 'provider-missing-scope'
  );
  const posted = await created.messenger.post(
    { home: 'TINSTALL:USENDER' },
    { kind: 'finished', body: 'ordinary text' }
  );
  assert.equal(posted.message, 'DCHAN:1.2');
  assert.deepEqual(methods, ['auth.test', 'files.info', 'chat.postMessage']);
  created.messenger.close();
});

it('file-info rate limits retain sanitized retry seconds at the provider boundary', async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', (url: string) => {
    if (url.endsWith('/auth.test'))
      return Promise.resolve(Response.json({ ok: true, team_id: 'TINSTALL', user_id: 'UBOT' }));
    attempts++;
    return Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '0' } }));
  });
  const created = await messenger.slackEntry.create(CREDENTIALS);
  assert.ok(created.ok && created.messenger.incomingFiles);
  const provider = created.messenger.incomingFiles;
  await assert.rejects(
    provider.metadata(FILE, new AbortController().signal),
    (error: unknown) => provider.refusal(error) === 'provider-ratelimited-retry-0'
  );
  assert.equal(attempts, 4);
  created.messenger.close();
});

it('counts decoded originals rather than compressed transfer length and asks for identity encoding', async (t) => {
  const original = 'ordinary gzip original\n'.repeat(20);
  const decodedSize = Buffer.byteLength(original);
  const r = await providerRig(t, {
    info: { mimetype: 'text/plain', size: decodedSize },
    reply: () =>
      new Response(original, {
        headers: {
          'content-encoding': 'gzip',
          'content-length': '47',
          'content-type': 'text/plain'
        }
      })
  });
  assert.equal((await r.bytes(FILE, undefined, decodedSize)).toString(), original);
  assert.equal((r.gets[0]?.headers as Record<string, string>)['Accept-Encoding'], 'identity');
  await t.test('decoded cap without metadata size', async (one) => {
    const capped = await providerRig(one, {
      info: { mimetype: 'text/plain' },
      reply: () =>
        new Response(original, { headers: { 'content-encoding': 'gzip', 'content-length': '47' } })
    });
    await assert.rejects(
      capped.bytes(FILE, undefined, decodedSize - 1),
      (error: unknown) => capped.provider.refusal(error) === 'provider-too-large'
    );
  });
  await t.test('decoded size must still match fresh metadata', async (one) => {
    const wrong = await providerRig(one, {
      info: { mimetype: 'text/plain', size: decodedSize - 1 },
      reply: () =>
        new Response(original, { headers: { 'content-encoding': 'gzip', 'content-length': '47' } })
    });
    await assert.rejects(
      wrong.bytes(FILE, undefined, decodedSize),
      (error: unknown) => wrong.provider.refusal(error) === 'provider-invalid-download'
    );
  });
  await t.test('unknown encoding is unavailable', async (one) => {
    const unknown = await providerRig(one, {
      reply: () => new Response(new Uint8Array([1]), { headers: { 'content-encoding': 'unknown' } })
    });
    await assert.rejects(
      unknown.bytes(),
      (error: unknown) => unknown.provider.refusal(error) === 'provider-invalid-download'
    );
  });
});

it('refuses text or JSON previews contradicting a binary original even without metadata size', async (t) => {
  for (const mime of ['application/json', 'application/problem+json', 'text/plain']) {
    await t.test(mime, async (one) => {
      const r = await providerRig(one, {
        info: { mimetype: 'image/png' },
        reply: () => new Response('{"preview":"metadata"}', { headers: { 'content-type': mime } })
      });
      await assert.rejects(
        r.bytes(FILE, undefined, 100),
        (error: unknown) => r.provider.refusal(error) === 'provider-invalid-download'
      );
    });
  }
});

it('preserves hosted JSON originals whose vendor MIME is structured JSON', async (t) => {
  const original = '{"original":true}';
  const r = await providerRig(t, {
    info: { mimetype: 'application/vnd.api+json' },
    reply: () => new Response(original, { headers: { 'content-type': 'application/vnd.api+json' } })
  });
  assert.equal((await r.bytes(FILE, undefined, 100)).toString(), original);
});
