import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, beforeEach, describe, it, type TestContext } from 'node:test';
import { resetDir, tempHome, writeJson } from '../helpers';
import type { Reply, Request, RequestBody } from '../../core/coordination/requests';
import * as requestCodec from '../../core/coordination/request_codec';
import * as incomingFixture from '../incoming_helpers';
import type { QueuedMessage } from '../../core/live';

type Requests = typeof import('../../core/coordination/requests');

let home: string;
let requests: Requests;

const dir = () => path.join(home, '.squadron', 'requests');
const files = async () => (await fs.readdir(dir()).catch(() => [])).sort();

before(async () => {
  home = await tempHome();
  requests = await import('../../core/coordination/requests');
});

// Every case asserts over the whole directory: one that fails mid-way must not
// leave files that turn the next six red as well.
beforeEach(() => resetDir(dir()));

const ok = (): Reply => ({ ok: true });

/** Posting is best effort in production; in a test, failing to post is a failure. */
async function post(body: RequestBody): Promise<string> {
  const file = await requests.postRequest(body);
  if (!file) {
    throw new Error('the request was never written');
  }
  return file;
}

type Gate = {
  pending: number;
  need: number;
  done: boolean;
  opened: Promise<void>;
  release: () => void;
};

function armGate(need: number): Gate {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending: 0, need, done: false, opened, release };
}

function exclusiveCreate(opts: unknown): boolean {
  return typeof opts === 'object' && opts !== null && 'flag' in opts && opts.flag === 'wx';
}

/**
 * Parks every exclusive create until `need` of them are inside it, then starts
 * the real creates in successive microtasks — before either syscall can
 * complete. One `Promise.all` of two claimants does not overlap the claim when
 * the machine is idle: the first finished before the second started, 0 of 300
 * (W6.5).
 */
async function overlappingClaims(
  t: TestContext,
  body: (race: (need: number, run: () => Promise<void>) => Promise<void>) => Promise<void>
): Promise<void> {
  const write = fs.writeFile;
  let gate = armGate(2);
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof write>) => {
    if (exclusiveCreate(args[2])) {
      const current = gate;
      current.pending += 1;
      if (current.pending >= current.need) {
        current.done = true;
        current.release();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('two claims never overlapped')), 5_000);
          current.opened.then(resolve);
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return write(...args);
  });
  await body(async (need, run) => {
    gate = armGate(need);
    try {
      await run();
    } finally {
      assert.equal(gate.done, true, 'the two claims never overlapped');
    }
  });
}

const RACE_RUNS = 24;

async function age(file: string): Promise<void> {
  const old = Date.now() / 1000 - 60;
  await fs.utimes(file, old, old);
}

describe('cross-window requests', () => {
  it('keeps fixed-kind authority contracts separate from origin labels', () => {
    const f = incomingFixture;
    const bodies: RequestBody[] = [
      { kind: 'models', windowId: 'w1' },
      { kind: 'rename', windowId: 'w1', pid: 7, startedAt: 70, title: 'name' },
      { kind: 'close', windowId: 'w1', pid: 7, startedAt: 70 },
      {
        kind: 'attach',
        windowId: 'w1',
        pid: 7,
        startedAt: 70,
        sessionWindowId: 'w2',
        path: '/work/file',
        from: 'sender'
      },
      {
        kind: 'incomingEvidenceV1',
        version: 1,
        windowId: f.host.windowId,
        expectedHost: f.host,
        challenge: f.OTHER_UUID,
        query: { kind: 'receiver', receiver: f.receiver }
      },
      { kind: 'fetchFile', version: 1, windowId: f.holder.host.windowId, ...f.fetchIdentity }
    ];
    for (const body of bodies) {
      const raw = { ...body, id: f.UUID, createdAt: Date.now() };
      assert.ok(requestCodec.readRequest(raw)?.request, body.kind);
      for (const origin of ['agent', 'composer', 'remote'])
        assert.equal(
          requestCodec.readRequest({ ...raw, origin })?.request,
          undefined,
          `${body.kind}: ${origin}`
        );
    }
    const start = {
      kind: 'remoteStartFilesV1',
      version: 1,
      windowId: f.host.windowId,
      expectedHost: f.host,
      attempt: f.attempt,
      localRoot: f.receiver.cwd,
      prompt: 'go',
      id: f.UUID,
      createdAt: Date.now(),
      origin: 'remote'
    };
    assert.ok(requestCodec.readRequest(start)?.request);
    for (const key of ['expectedHost', 'attempt', 'version']) {
      const missing = { ...start } as Record<string, unknown>;
      delete missing[key];
      assert.equal(requestCodec.readRequest(missing)?.request, undefined, key);
    }
  });

  it('carries a warm request whole, under no origin, to its own policy', async () => {
    const { classifyRequest, validOrigin } = await import('../../core/coordination/origin');
    for (const on of [true, false]) {
      const body: RequestBody = { kind: 'warm', windowId: 'w1', pid: 7, startedAt: 70, on };
      const raw = { ...body, id: 'r-warm', createdAt: 1000 };
      const read = requestCodec.readRequest(raw)?.request;
      assert.deepEqual(read, raw);
      assert.ok(read);
      assert.equal(classifyRequest(read)?.policy, 'warm');
      for (const origin of ['agent', 'composer', 'remote']) {
        assert.equal(validOrigin(body, origin), false, origin);
        assert.equal(requestCodec.readRequest({ ...raw, origin })?.request, undefined, origin);
      }
    }
    const raw = { kind: 'warm', windowId: 'w1', pid: 7, startedAt: 70, id: 'r', createdAt: 1 };
    assert.equal(requestCodec.readRequest(raw)?.request, undefined, 'on is required');
    assert.equal(requestCodec.readRequest({ ...raw, on: 'yes' })?.request, undefined);
  });

  it('preserves legacy action classification and carries compatible explicit metadata', async () => {
    const { classifyRequest } = await import('../../core/coordination/origin');
    const addr = { windowId: 'w1', pid: 7, startedAt: 70 };
    const cases: { body: RequestBody; policy: string; origin: 'agent' | 'composer' | 'remote' }[] =
      [
        {
          body: { ...addr, kind: 'send', text: 'go', from: 'old-shim' },
          policy: 'composer-send',
          origin: 'composer'
        },
        {
          body: { ...addr, kind: 'send', text: 'go', via: 'verb', from: 'caller' },
          policy: 'agent-send',
          origin: 'agent'
        },
        {
          body: { kind: 'open', windowId: 'w1', cwd: '/work' },
          policy: 'composer-open',
          origin: 'composer'
        },
        {
          body: { kind: 'open', windowId: 'w1', cwd: '/work', resume: 'old' },
          policy: 'composer-open',
          origin: 'composer'
        },
        {
          body: { kind: 'open', windowId: 'w1', cwd: '/work', prompt: '' },
          policy: 'agent-spawn',
          origin: 'agent'
        },
        {
          body: {
            kind: 'open',
            windowId: 'w1',
            cwd: '/work',
            prompt: 'go',
            via: 'remote',
            remote: 'holder'
          },
          policy: 'remote-open',
          origin: 'remote'
        },
        {
          body: { ...addr, kind: 'answer', askId: 'ask', text: 'blue', from: 'caller' },
          policy: 'agent-answer',
          origin: 'agent'
        },
        {
          body: { ...addr, kind: 'interrupt', remote: 'holder' },
          policy: 'remote-interrupt',
          origin: 'remote'
        },
        {
          body: { ...addr, kind: 'deny', requestId: 'ask', remote: 'holder' },
          policy: 'remote-deny',
          origin: 'remote'
        },
        {
          body: { ...addr, kind: 'personAnswer', askId: 'ask', text: 'blue', remote: 'holder' },
          policy: 'remote-answer',
          origin: 'remote'
        }
      ];
    for (const { body, policy, origin } of cases) {
      for (const metadata of [{}, { origin }]) {
        const file = await post({ ...body, ...metadata });
        let seen: Request | undefined;
        await requests.claimRequests('w1', (request) => {
          seen = request;
          return ok();
        });
        assert.ok(seen);
        assert.equal(classifyRequest(seen)?.policy, policy);
        assert.equal(seen.origin, 'origin' in metadata ? origin : undefined);
        assert.deepEqual(await requests.awaitReply(file), { ok: true });
      }
    }
  });

  it('refuses explicit origin conflicts before a request reaches its handler', async () => {
    const bodies: Record<string, unknown>[] = [
      {
        kind: 'send',
        windowId: 'w1',
        pid: 7,
        startedAt: 70,
        text: 'go',
        via: 'verb',
        origin: 'composer'
      },
      { kind: 'send', windowId: 'w1', pid: 7, startedAt: 70, text: 'go', origin: 'agent' },
      { kind: 'send', windowId: 'w1', pid: 7, startedAt: 70, text: 'go', origin: 'remote' },
      { kind: 'open', windowId: 'w1', cwd: '/work', prompt: 'go', origin: 'composer' },
      { kind: 'open', windowId: 'w1', cwd: '/work', origin: 'agent' },
      {
        kind: 'open',
        windowId: 'w1',
        cwd: '/work',
        via: 'remote',
        remote: 'holder',
        origin: 'agent'
      },
      {
        kind: 'answer',
        windowId: 'w1',
        pid: 7,
        startedAt: 70,
        text: 'blue',
        askId: 'ask',
        origin: 'remote'
      },
      { kind: 'close', windowId: 'w1', pid: 7, startedAt: 70, origin: 'composer' },
      { kind: 'models', windowId: 'w1', origin: 'agent' }
    ];
    const send = { kind: 'send', windowId: 'w1', pid: 7, startedAt: 70, text: 'go' };
    for (const origin of [null, 7, {}, '', 'wait', 'warm', 'future'])
      bodies.push({ ...send, origin });
    for (const body of bodies) {
      await writeJson(path.join(dir(), 'origin.request.json'), {
        ...body,
        id: 'origin',
        createdAt: Date.now()
      });
      let handled = false;
      await requests.claimRequests('w1', () => {
        handled = true;
        return ok();
      });
      assert.equal(handled, false, JSON.stringify(body));
      assert.deepEqual(await requests.awaitReply(path.join(dir(), 'origin.request.json')), {
        ok: false,
        reason: requests.MALFORMED
      });
    }
  });

  it('carries typed close execution failures over the file protocol and rejects malformed outcomes', async () => {
    for (const closeFailure of ['unavailable', 'failed', 'gone'] as const) {
      const file = await post({ kind: 'close', windowId: 'w1', pid: 7, startedAt: 70 });
      await requests.claimRequests('w1', () => ({ ok: false, closeFailure, reason: 'not closed' }));
      assert.deepEqual(await requests.awaitReply(file), {
        ok: false,
        closeFailure,
        reason: 'not closed'
      });
    }
    for (const raw of [
      { ok: true, closeFailure: 'gone' },
      { ok: false, closeFailure: 7 },
      { ok: false, closeFailure: 'new-outcome' }
    ]) {
      const decoded = requestCodec.readReply(raw);
      assert.equal(decoded?.ok, false);
      assert.equal(decoded?.closeFailure, undefined);
    }
    assert.deepEqual(requestCodec.readReply({ ok: false, reason: 'legacy refusal' }), {
      ok: false,
      reason: 'legacy refusal'
    });
  });

  it('carries validated optional correlation on send, personAnswer and open, and refuses malformed identities', async () => {
    const bodies: RequestBody[] = [
      { kind: 'send', windowId: 'w1', pid: 7, startedAt: 70, text: 'same words' },
      {
        kind: 'personAnswer',
        windowId: 'w1',
        pid: 7,
        startedAt: 70,
        askId: 'ask',
        text: 'blue',
        remote: 'w0'
      },
      { kind: 'open', windowId: 'w1', cwd: '/work', prompt: 'go', via: 'remote', remote: 'w0' }
    ];
    for (const body of bodies) {
      for (const correlation of [undefined, 'remote-message']) {
        const file = await post({ ...body, ...(correlation === undefined ? {} : { correlation }) });
        let seen: Request | undefined;
        await requests.claimRequests('w1', (request) => {
          seen = request;
          return ok();
        });
        assert.equal(seen && 'correlation' in seen ? seen.correlation : undefined, correlation);
        assert.deepEqual(await requests.awaitReply(file), { ok: true });
      }
      for (const correlation of [7, '', 'bad\nidentity']) {
        const file = await post(body);
        const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
        await fs.writeFile(file, JSON.stringify({ ...raw, correlation }));
        await requests.claimRequests('w1', () => {
          throw new Error('must not route malformed identity');
        });
        assert.deepEqual(await requests.awaitReply(file), {
          ok: false,
          reason: requests.MALFORMED
        });
      }
    }
  });

  it('reads optional authoritative message facts from replies and strips malformed evidence', async () => {
    for (const messageFacts of [
      [{ correlation: 'message', phase: 'processing' }],
      [{ correlation: 'message', phase: 'done' }],
      [{ correlation: 'message', phase: 'unsuccessful' }],
      [{ correlation: 'message', phase: 'unknown' }],
      [{ correlation: 'message', phase: 'queued' }],
      [{ correlation: 'message', phase: 'idle' }]
    ]) {
      const file = await post({ kind: 'send', windowId: 'w1', pid: 7, startedAt: 70, text: 'go' });
      await fs.writeFile(
        file.replace('.request.json', '.reply.json'),
        JSON.stringify({ ok: true, messageFacts })
      );
      const reply = await requests.awaitReply(file);
      assert.deepEqual(
        reply?.messageFacts,
        messageFacts[0]?.phase === 'idle' ? undefined : messageFacts
      );
      await fs.rm(file, { force: true });
    }
  });

  it('hands a request to the window it names, once, and returns its answer', async () => {
    const file = await post({ kind: 'open', windowId: 'w1', cwd: '/tmp/x' });

    const seen: Request[] = [];
    await requests.claimRequests('w1', (request) => {
      seen.push(request);
      return { ok: true, reason: 'started' };
    });
    // Claimed, so a second window — or a second tick — finds nothing left.
    await requests.claimRequests('w1', () => {
      throw new Error('claimed twice');
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.kind, 'open');
    assert.deepEqual(await requests.awaitReply(file), { ok: true, reason: 'started' });
    assert.deepEqual(await files(), [], 'request and reply are both swept');
  });

  /**
   * Two copies of the extension in one host share `env.sessionId`, and so
   * claim the same requests on the same tick. With `fs.rm` as the claim both
   * won every time, and every spawn started two sessions.
   */
  it('hands a request to one of two claimants racing for it', async () => {
    const file = await post({ kind: 'open', windowId: 'w1', cwd: '/tmp/x' });

    let handled = 0;
    const handle = (): Reply => {
      handled++;
      return { ok: true };
    };
    await Promise.all([requests.claimRequests('w1', handle), requests.claimRequests('w1', handle)]);

    assert.equal(handled, 1);
    assert.deepEqual(await requests.awaitReply(file), { ok: true });
    assert.deepEqual(await files(), [], 'nothing taken is left behind');
  });

  it('gives one of two overlapping claims the request, over a run of them', async (t) => {
    await overlappingClaims(t, async (race) => {
      for (let run = 0; run < RACE_RUNS; run++) {
        const file = await post({ kind: 'open', windowId: 'w1', cwd: '/tmp/x' });
        let handled = 0;
        const handle = (): Reply => {
          handled++;
          return { ok: true };
        };
        await race(2, () =>
          Promise.all([
            requests.claimRequests('w1', handle),
            requests.claimRequests('w1', handle)
          ]).then(() => undefined)
        );
        assert.equal(handled, 1, `run ${run}`);
        assert.deepEqual(await requests.awaitReply(file), { ok: true }, `run ${run}`);
        assert.deepEqual(await files(), [], `run ${run}: a claim was left behind`);
      }
    });
  });

  it('does not serve a request whose claim is still fresh', async () => {
    const file = path.join(dir(), 'fresh.request.json');
    await writeJson(file, {
      kind: 'close',
      windowId: 'w1',
      pid: 1,
      startedAt: 10,
      id: 'fresh',
      createdAt: Date.now()
    });
    await fs.writeFile(`${file}.claim`, '');

    let handled = 0;
    await requests.claimRequests('w1', () => {
      handled++;
      return ok();
    });

    assert.equal(handled, 0);
    assert.deepEqual(await files(), ['fresh.request.json', 'fresh.request.json.claim']);
  });

  it('does not reclaim an old marker while its taker is still unlinking', async (t) => {
    const file = await post({ kind: 'close', windowId: 'w1', pid: 7, startedAt: 70 });
    let entered: () => void = () => undefined;
    const unlinking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unlink = fs.unlink;
    let unlinks = 0;
    t.mock.method(fs, 'unlink', async (...args: Parameters<typeof unlink>) => {
      if (args[0] !== file) return unlink(...args);
      if (++unlinks === 1) {
        entered();
        await held;
      }
      try {
        await unlink(...args);
      } catch (error) {
        // Overlapping unlinks can both succeed on APFS; force that observed
        // outcome so exclusivity cannot depend on which syscall returns first.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
    let handled = 0;
    const handle = (): Reply => {
      handled++;
      return ok();
    };
    const first = requests.claimRequests('w1', handle);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        unlinking,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error('the first taker never entered')), 5_000);
        })
      ]);
      await age(`${file}.claim`);
      await requests.claimRequests('w1', handle);
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await first;
    }
    assert.equal(handled, 1, 'age cannot prove that the original taker died');
    assert.equal(unlinks, 1, 'only the original taker may unlink the request');
    assert.deepEqual(await requests.awaitReply(file), ok());
  });

  it('expires an abandoned request before sweeping its claim', async () => {
    const file = path.join(dir(), 'stale.request.json');
    await writeJson(file, {
      kind: 'close',
      windowId: 'w1',
      pid: 1,
      startedAt: 10,
      id: 'stale',
      createdAt: Date.now() - 60_000
    });
    await fs.writeFile(`${file}.claim`, '');
    await age(`${file}.claim`);
    const handle = (): Reply => {
      assert.fail('an abandoned request must not be replayed');
    };
    await requests.claimRequests('w1', handle);
    assert.deepEqual(await files(), ['stale.request.json.claim']);
    await Promise.all([requests.claimRequests('w1', handle), requests.claimRequests('w1', handle)]);
    assert.deepEqual(await files(), []);
  });

  it('sweeps a stale claim whose request is already gone and leaves a fresh one', async () => {
    const gone = path.join(dir(), 'gone.request.json.claim');
    const live = path.join(dir(), 'live.request.json.claim');
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(gone, '');
    await fs.writeFile(live, '');
    await age(gone);

    await requests.claimRequests('w1', () => {
      throw new Error('there was nothing to serve');
    });

    assert.deepEqual(await files(), ['live.request.json.claim']);
  });

  it('carries the new pid on a successful open so the asking panel can reveal', async () => {
    // startOwned already returns { ok, pid }; without the pid on the wire the
    // initiator cannot select or arm the session it asked the peer to start.
    const file = await post({ kind: 'open', windowId: 'w1', cwd: '/tmp/x' });
    await requests.claimRequests('w1', () => ({ ok: true, pid: 4242 }));
    assert.deepEqual(await requests.awaitReply(file), { ok: true, pid: 4242 });
  });

  it('round-trips a pick refusal and does not invent a cause for any other', async () => {
    const pick = await post({ kind: 'open', windowId: 'w1', cwd: '/tmp/x' });
    await requests.claimRequests('w1', () => ({
      ok: false,
      reason: 'Grok could not select model',
      cause: 'pick'
    }));
    assert.deepEqual(await requests.awaitReply(pick), {
      ok: false,
      reason: 'Grok could not select model',
      cause: 'pick'
    });

    const fleet = await post({ kind: 'open', windowId: 'w1', cwd: '/tmp/x' });
    await requests.claimRequests('w1', () => ({ ok: false, reason: '15 live sessions' }));
    const reply: Reply | undefined = await requests.awaitReply(fleet);
    assert.equal(reply?.cause, undefined);
    assert.deepEqual(reply, { ok: false, reason: '15 live sessions' });
  });

  it('round-trips a close to the window whose pipe holds that session', async () => {
    // The pid is the whole request: the window addressed ends the session it
    // drives, which is the half a signal from here could never do — dropping
    // the registry entry, so no card is left reading `unknown` behind it.
    const file = await post({ kind: 'close', windowId: 'w1', pid: 7, startedAt: 70 });

    await requests.claimRequests('w2', () => {
      throw new Error('stopped someone else’s session');
    });

    const seen: Request[] = [];
    await requests.claimRequests('w1', (request) => {
      seen.push(request);
      return ok();
    });
    const got = seen[0]?.kind === 'close' ? seen[0] : undefined;
    assert.equal(got?.pid, 7);
    assert.deepEqual(await requests.awaitReply(file), { ok: true });
  });

  it('carries a send’s images inline, with no file written anywhere', async () => {
    const images = [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }];
    const file = await post({
      kind: 'send',
      windowId: 'w1',
      pid: 7,
      startedAt: 70,
      text: 'look',
      images
    });

    const seen: Request[] = [];
    await requests.claimRequests('w1', (request) => {
      seen.push(request);
      return ok();
    });
    assert.deepEqual(seen[0]?.kind === 'send' ? seen[0].images : undefined, images);
    await requests.awaitReply(file);
  });

  it('carries the queued message target with the send that owns it', async () => {
    const queued: QueuedMessage = {
      id: 'q1',
      text: 'use this pick',
      queuedAt: 1,
      target: { model: 'claude-opus-4-1', window: 200_000, effort: 'high' }
    };
    const file = await post({
      kind: 'send',
      windowId: 'w1',
      pid: 7,
      startedAt: 70,
      text: queued.text,
      target: queued.target
    });

    const seen: Request[] = [];
    await requests.claimRequests('w1', (request) => {
      seen.push(request);
      return ok();
    });
    assert.deepEqual(seen[0]?.kind === 'send' ? seen[0].target : undefined, queued.target);
    await requests.awaitReply(file);
  });

  // The verb's whole body, since every field of it is what tells the window
  // this is not the panel's composer box.
  it('carries what marks a send as one session addressing another', async () => {
    const file = await post({
      kind: 'send',
      windowId: 'w1',
      pid: 7,
      startedAt: 70,
      text: 'take the review',
      via: 'verb',
      from: 'sess-a',
      interrupt: true,
      force: true
    });

    const seen: Request[] = [];
    await requests.claimRequests('w1', (request) => {
      seen.push(request);
      return ok();
    });
    const got = seen[0]?.kind === 'send' ? seen[0] : undefined;
    assert.equal(got?.via, 'verb');
    assert.equal(got?.from, 'sess-a');
    assert.equal(got?.interrupt, true);
    assert.equal(got?.force, true);
    await requests.awaitReply(file);
  });

  it('carries an answer to the window whose pipe holds the asker', async () => {
    const file = await post({
      kind: 'answer',
      windowId: 'w1',
      pid: 7,
      startedAt: 70,
      askId: 'req_7',
      text: '"Which database?"="Postgres"',
      from: 'sess-a',
      force: true
    });

    const seen: Request[] = [];
    await requests.claimRequests('w1', (request) => {
      seen.push(request);
      return ok();
    });
    const got = seen[0]?.kind === 'answer' ? seen[0] : undefined;
    assert.equal(got?.askId, 'req_7');
    assert.equal(got?.text, '"Which database?"="Postgres"');
    assert.equal(got?.from, 'sess-a');
    assert.equal(got?.force, true);
    assert.notEqual(got?.id, 'req_7', 'the envelope keeps its own id');
    assert.deepEqual(await requests.awaitReply(file), { ok: true });
  });

  // The composer posts none of them, and must stay the request it always was.
  it('leaves a send from the panel with nothing that marks it a verb', async () => {
    const file = await post({
      kind: 'send',
      windowId: 'w1',
      pid: 7,
      startedAt: 70,
      text: 'typed'
    });

    const seen: Request[] = [];
    await requests.claimRequests('w1', (request) => {
      seen.push(request);
      return ok();
    });
    const got = seen[0]?.kind === 'send' ? seen[0] : undefined;
    assert.equal(got?.via, undefined);
    assert.equal(got?.from, undefined);
    assert.equal(got?.interrupt, undefined);
    await requests.awaitReply(file);
  });

  it('leaves another window’s request alone', async () => {
    const file = await post({ kind: 'close', windowId: 'w1', pid: 1, startedAt: 10 });
    await requests.claimRequests('w2', () => {
      throw new Error('answered someone else’s request');
    });
    assert.equal((await files()).length, 1);

    await requests.claimRequests('w1', ok);
    await requests.awaitReply(file);
  });

  it('answers with the failure when the handler throws', async () => {
    const file = await post({
      kind: 'send',
      windowId: 'w1',
      pid: 1,
      startedAt: 10,
      text: 'hi'
    });
    await requests.claimRequests('w1', () => {
      throw new Error('that session just closed');
    });
    const reply = await requests.awaitReply(file);
    assert.equal(reply?.ok, false);
    assert.match(reply?.reason ?? '', /just closed/);
  });

  it('gives up on a window that never answers, and leaves nothing behind', async () => {
    const file = await post({ kind: 'close', windowId: 'gone', pid: 1, startedAt: 10 });
    assert.equal(await requests.awaitReply(file, 300), undefined);
    assert.deepEqual(await files(), []);
  });

  it('sweeps a request no window ever came for', async () => {
    await writeJson(path.join(dir(), 'stale.request.json'), {
      kind: 'close',
      windowId: 'gone',
      pid: 1,
      startedAt: 10,
      id: 'stale',
      createdAt: Date.now() - 60_000
    });
    await requests.claimRequests('w1', ok);
    assert.deepEqual(await files(), []);
  });

  it('sweeps its own request rather than serving it late', async () => {
    // A window closed with requests pending used to serve the whole backlog on
    // its next start, however old: the staleness check sat only in the branch
    // for other windows' requests. Harmless for a focus; once an open can carry
    // a task, it is a burst of sessions nobody is waiting for any more.
    const served: string[] = [];
    await writeJson(path.join(dir(), 'mine.request.json'), {
      kind: 'open',
      windowId: 'w1',
      cwd: '/tmp',
      prompt: 'take ENG-412',
      id: 'mine',
      createdAt: Date.now() - 60_000
    });
    await requests.claimRequests('w1', (request) => {
      served.push(request.id);
      return { ok: true };
    });
    assert.deepEqual(served, []);
    assert.deepEqual(await files(), []);
  });

  it('carries a prompt, its parent and its author to the window that will spawn it', async () => {
    let seen: Request | undefined;
    const file = await requests.postRequest({
      kind: 'open',
      windowId: 'w1',
      cwd: '/tmp/repo',
      prompt: "take ENG-412; it's urgent",
      parentSessionId: 'parent-1',
      from: 'caller-1'
    });
    assert.ok(file);
    await requests.claimRequests('w1', (request) => {
      seen = request;
      return { ok: true };
    });
    assert.equal(seen?.kind, 'open');
    assert.equal(seen?.kind === 'open' ? seen.prompt : undefined, "take ENG-412; it's urgent");
    assert.equal(seen?.kind === 'open' ? seen.parentSessionId : undefined, 'parent-1');
    assert.equal(seen?.kind === 'open' ? seen.from : undefined, 'caller-1');
    await requests.awaitReply(file);
  });

  it('carries the model a spawn asked to start on', async () => {
    let seen: Request | undefined;
    const file = await requests.postRequest({
      kind: 'open',
      windowId: 'w1',
      cwd: '/tmp/repo',
      prompt: 'go',
      brand: 'claude',
      model: 'opus'
    });
    assert.ok(file);
    await requests.claimRequests('w1', (request) => {
      seen = request;
      return { ok: true };
    });
    assert.equal(seen?.kind === 'open' ? seen.brand : undefined, 'claude');
    assert.equal(seen?.kind === 'open' ? seen.model : undefined, 'opus');
    await requests.awaitReply(file);
  });

  it('carries the effort a start asked for, beside the rest of the pick', async () => {
    let seen: Request | undefined;
    const file = await requests.postRequest({
      kind: 'open',
      windowId: 'w1',
      cwd: '/tmp/repo',
      resume: 'abc',
      brand: 'claude',
      model: 'opus',
      window: 200_000,
      effort: 'high'
    });
    assert.ok(file);
    await requests.claimRequests('w1', (request) => {
      seen = request;
      return { ok: true };
    });
    const open = seen?.kind === 'open' ? seen : undefined;
    // Flat on disk, all four of them. In memory these travel as one
    // `LaunchTarget`; a request file is where that value is taken apart, and it
    // stays flat so version skew is one field wide.
    assert.deepEqual(
      {
        brand: open?.brand,
        model: open?.model,
        window: open?.window,
        effort: open?.effort
      },
      { brand: 'claude', model: 'opus', window: 200_000, effort: 'high' }
    );
    await requests.awaitReply(file);
  });

  /**
   * **An older window's file, and the two absences that must not become one.**
   *
   * `claimRequests` keeps the fields a file states and no others, with no
   * version decoder, so a field a newer panel added is simply not there. An absent `effort` reads as no
   * override — which is what a start took before the field existed.
   *
   * An absent `brand` is the load-bearing half: it means "inherit, else
   * Claude", and it must stay distinct from a brand string this build does not
   * recognise, which reaches `adapter()`, finds no row, and refuses the start.
   * Folding the two would start the wrong CLI on somebody else's request.
   */
  it('decodes an older open that states no effort, absent brand still not unknown', async () => {
    const seen: Request[] = [];
    const at = Date.now();
    await writeJson(path.join(dir(), 'old.request.json'), {
      kind: 'open',
      windowId: 'w1',
      cwd: '/tmp/repo',
      resume: 'abc',
      id: 'old',
      createdAt: at
    });
    await writeJson(path.join(dir(), 'odd.request.json'), {
      kind: 'open',
      windowId: 'w1',
      cwd: '/tmp/repo',
      brand: 'gemini',
      id: 'odd',
      createdAt: at
    });
    await requests.claimRequests('w1', (request) => {
      seen.push(request);
      return { ok: true };
    });
    const old = seen.find((r) => r.id === 'old');
    const odd = seen.find((r) => r.id === 'odd');
    assert.equal(old?.kind, 'open', 'the older request did not decode');
    assert.equal(old?.kind === 'open' && 'effort' in old, false, 'an effort was invented');
    assert.equal(old?.kind === 'open' ? old.brand : 'set', undefined, 'an absent brand was filled');
    // Present and unrecognised — `startOwned` hands this to `adapter()`, which
    // has no row for it and refuses. It must never arrive looking absent.
    assert.equal(odd?.kind === 'open' ? odd.brand : undefined, 'gemini');
    // Collected, or the two replies outlive this case and the next one to read
    // the directory finds them.
    await requests.awaitReply(path.join(dir(), 'old.request.json'));
    await requests.awaitReply(path.join(dir(), 'odd.request.json'));
  });

  it('hands on a request field by field, and refuses one whose fields are not the kind’s', async () => {
    // Read with a cast, a Remote kind with no `remote` reached the handler
    // looking whole, and a guard reading the field let it through.
    const at = Date.now();
    const write = (name: string, body: Record<string, unknown>) =>
      writeJson(path.join(dir(), `${name}.request.json`), { ...body, id: name, createdAt: at });
    const where = { windowId: 'w1', pid: 1, startedAt: 10 };
    await write('bare', { ...where, kind: 'interrupt' });
    await write('typed', { ...where, kind: 'deny', requestId: 7, remote: 'w0' });
    await write('optional', { ...where, kind: 'send', text: 'hi', images: 'not a list' });
    await write('stray', { ...where, kind: 'close', decision: { allow: true } });
    await write('future', { ...where, kind: 'teleport', there: 'mars' });
    const seen: Request[] = [];
    await requests.claimRequests('w1', (request) => {
      seen.push(request);
      return { ok: true };
    });
    assert.deepEqual(seen.map((r) => r.id).sort(), ['future', 'stray']);
    assert.deepEqual(
      seen.find((r) => r.id === 'stray'),
      { ...where, kind: 'close', id: 'stray', createdAt: at }
    );
    // A kind this build does not know goes on whole, so the window answers it
    // as a newer one rather than as unreadable.
    assert.equal(
      (seen.find((r) => r.id === 'future') as unknown as { there: string }).there,
      'mars'
    );
    for (const name of ['bare', 'typed', 'optional']) {
      const reply = await requests.awaitReply(path.join(dir(), `${name}.request.json`));
      assert.deepEqual(reply, { ok: false, reason: requests.MALFORMED }, name);
    }
    await requests.awaitReply(path.join(dir(), 'stray.request.json'));
    await requests.awaitReply(path.join(dir(), 'future.request.json'));
  });

  it('leaves a bare open exactly as it was', async () => {
    let seen: Request | undefined;
    const file = await requests.postRequest({ kind: 'open', windowId: 'w1', cwd: '/tmp/repo' });
    assert.ok(file);
    await requests.claimRequests('w1', (request) => {
      seen = request;
      return { ok: true };
    });
    assert.equal(seen?.kind === 'open' ? seen.prompt : 'set', undefined);
    await requests.awaitReply(file);
  });

  it('sweeps a reply the asking panel never collected', async () => {
    await writeJson(path.join(dir(), 'orphan.reply.json'), { ok: true });
    const old = Date.now() / 1000 - 60;
    await fs.utimes(path.join(dir(), 'orphan.reply.json'), old, old);
    await requests.claimRequests('w1', ok);
    assert.deepEqual(await files(), []);
  });
});

/**
 * Silence is two answers, and every caller before `startRun` treated them as
 * one because falling back cost nothing. A caller that does the work itself
 * instead needs them apart: doing it twice is two dev servers in two windows
 * under one record, and the one that loses the record cannot be stopped.
 */
describe('awaitReplyDetailed', () => {
  it('reports an answer as claimed, because someone answered it', async () => {
    const file = await post({ kind: 'close', windowId: 'w1', pid: 7, startedAt: 70 });
    await requests.claimRequests('w1', () => ({ ok: true }));

    assert.deepEqual(await requests.awaitReplyDetailed(file, 300), {
      reply: { ok: true },
      claimed: true
    });
  });

  /** The request file is still sitting there, so nobody is coming for it. */
  it('reports a request nobody claimed as unclaimed', async () => {
    const file = await post({ kind: 'close', windowId: 'nobody', pid: 7, startedAt: 70 });

    assert.deepEqual(await requests.awaitReplyDetailed(file, 300), { claimed: false });
    assert.deepEqual(await files(), [], 'and it is swept on the way out');
  });

  /**
   * `claimRequests` removes the file *before* it runs the handler, so a handler
   * that outruns the deadline leaves exactly this trace — and it is the whole
   * reason a caller must not fall back here.
   */
  it('reports a claimed-but-unanswered request as claimed', async () => {
    const file = await post({ kind: 'close', windowId: 'w1', pid: 7, startedAt: 70 });
    // What a slow handler looks like from outside: claimed, no reply yet.
    await fs.rm(file);

    assert.deepEqual(await requests.awaitReplyDetailed(file, 300), { claimed: true });
  });

  /**
   * The verdict has to *be* the claim, not a look at it.
   *
   * **This does not prove the fix, and cannot.** The race is one `unlink` wide,
   * nothing can be scheduled into it, and the old stat-then-remove satisfies
   * this test as readily as the new take-it-to-know-it — a first attempt that
   * raced a real handler passed either way and asserted nothing at all. What is
   * pinned here is the invariant the fix exists to hold: a verdict of "nobody
   * claimed it" is only sound if nobody can claim it afterwards either.
   */
  it('takes the request when it reports nobody claimed it', async () => {
    const file = await post({ kind: 'close', windowId: 'w1', pid: 7, startedAt: 70 });

    const answer = await requests.awaitReplyDetailed(file, 200);
    assert.deepEqual(answer, { claimed: false });

    // The proof: a handler arriving now finds nothing, so `claimed: false` can
    // never be a second window's cue to do work someone else is already doing.
    let handled = false;
    await requests.claimRequests('w1', () => {
      handled = true;
      return { ok: true };
    });
    assert.equal(handled, false, 'the request outlived a verdict that said nobody had it');
  });

  /**
   * A handler slower than the deadline. Its refusal used to be dropped and
   * reported as acceptance, which for a routed dev server meant the click
   * started nothing in either window and said nothing about it.
   *
   * `graceMs` is what a caller pays to tell a refusal from silence. Without it
   * this returns `{ claimed: true }` and the reason is lost.
   */
  it('waits past the deadline for a claimed request when asked to', async () => {
    const file = await post({ kind: 'close', windowId: 'w1', pid: 7, startedAt: 70 });
    const waiting = requests.awaitReplyDetailed(file, 200, 2_000);

    // Claimed early, answered well after the deadline has passed.
    await requests.claimRequests('w1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { ok: false, reason: 'different command' };
    });

    assert.deepEqual(await waiting, {
      reply: { ok: false, reason: 'different command' },
      claimed: true
    });
  });

  it('gives up on a claimed request that is never answered', async () => {
    const file = await post({ kind: 'close', windowId: 'w1', pid: 7, startedAt: 70 });
    await fs.rm(file); // claimed by a window that then died mid-handle

    assert.deepEqual(await requests.awaitReplyDetailed(file, 200, 300), { claimed: true });
  });

  it('a deadline claim and a handler cannot both take the request', async (t) => {
    await overlappingClaims(t, async (race) => {
      for (let run = 0; run < RACE_RUNS; run++) {
        const file = await post({ kind: 'close', windowId: 'w1', pid: 7, startedAt: 70 });
        let handled = 0;
        let answer: { claimed: boolean } = { claimed: false };
        await race(2, async () => {
          const [got] = await Promise.all([
            requests.awaitReplyDetailed(file, 0),
            requests.claimRequests('w1', () => {
              handled++;
              return ok();
            })
          ]);
          answer = got;
        });
        assert.equal(handled, answer.claimed ? 1 : 0, `run ${run}`);
        assert.ok(handled <= 1, `run ${run}`);
        // The handler can write the reply after grace 0 has already removed it.
        const left = (await files()).filter((name) => !name.endsWith('.reply.json'));
        assert.deepEqual(left, [], `run ${run}: a claim was left behind`);
      }
    });
  });

  it('reports a fresh claim as claimed and leaves the request', async () => {
    const file = path.join(dir(), 'fresh.request.json');
    await writeJson(file, {
      kind: 'close',
      windowId: 'w1',
      pid: 1,
      startedAt: 10,
      id: 'fresh',
      createdAt: Date.now()
    });
    await fs.writeFile(`${file}.claim`, '');

    assert.deepEqual(await requests.awaitReplyDetailed(file, 0), { claimed: true });
    assert.deepEqual(await files(), ['fresh.request.json', 'fresh.request.json.claim']);
  });

  it('reports an old claim as uncertain and does not replay it on the next poll', async () => {
    const file = path.join(dir(), 'stale.request.json');
    await writeJson(file, {
      kind: 'close',
      windowId: 'w1',
      pid: 1,
      startedAt: 10,
      id: 'stale',
      createdAt: Date.now()
    });
    await fs.writeFile(`${file}.claim`, '');
    await age(`${file}.claim`);

    assert.deepEqual(await requests.awaitReplyDetailed(file, 0), { claimed: true });
    assert.deepEqual(await files(), ['stale.request.json', 'stale.request.json.claim']);

    let handled = 0;
    await requests.claimRequests('w1', () => {
      handled++;
      return ok();
    });
    assert.equal(handled, 0);
    assert.deepEqual(await files(), ['stale.request.json', 'stale.request.json.claim']);
  });
});

/**
 * Remote's kinds (M2 Step 4): each names the session by pid and start, as
 * `close` does, and carries the holder window it was sent on behalf of.
 */
describe('Remote request kinds', () => {
  const bodies: RequestBody[] = [
    { kind: 'interrupt', windowId: 'w1', pid: 7, startedAt: 70, remote: 'w0' },
    {
      kind: 'deny',
      windowId: 'w1',
      pid: 7,
      startedAt: 70,
      requestId: 'perm-1',
      reason: 'not that file',
      remote: 'w0'
    },
    { kind: 'deny', windowId: 'w1', pid: 7, startedAt: 70, requestId: 'perm-2', remote: 'w0' },
    {
      kind: 'personAnswer',
      windowId: 'w1',
      pid: 7,
      startedAt: 70,
      askId: 'ask-1',
      text: 'the blue one',
      remote: 'w0'
    },
    {
      kind: 'open',
      windowId: 'w1',
      cwd: '/tmp/x',
      prompt: 'tidy the readme',
      via: 'remote',
      remote: 'w0',
      brand: 'grok'
    }
  ];

  for (const body of bodies) {
    it(`round-trips ${body.kind}${body.kind === 'deny' && !body.reason ? ' with no reason' : ''}`, async () => {
      const file = await post(body);
      const seen: Request[] = [];
      await requests.claimRequests('w1', (request) => {
        seen.push(request);
        return ok();
      });
      assert.equal(seen.length, 1);
      const { id, createdAt, ...got } = seen[0] as Request;
      assert.equal(typeof id, 'string');
      assert.equal(typeof createdAt, 'number');
      assert.deepEqual(got, body);
      assert.deepEqual(await requests.awaitReply(file), { ok: true });
    });
  }
});

/**
 * M3's agent file: addressed to the holder's window, naming the session's own
 * window beside it, since the holder serves it and the session's pipe is not
 * involved.
 */
describe('the attach kind', () => {
  const bodies: RequestBody[] = [
    {
      kind: 'attach',
      windowId: 'w1',
      pid: 7,
      startedAt: 70,
      sessionWindowId: 'w2',
      path: '/work/app/plot.png',
      caption: 'the plot',
      from: 'sid-7'
    },
    {
      kind: 'attach',
      windowId: 'w1',
      pid: 7,
      startedAt: 70,
      sessionWindowId: 'w2',
      path: '/work/app/plot.png',
      from: 'sid-7'
    }
  ];

  for (const body of bodies) {
    it(`round-trips an attach${'caption' in body ? '' : ' with no caption'}`, async () => {
      const file = await post(body);
      const seen: Request[] = [];
      await requests.claimRequests('w1', (request) => {
        seen.push(request);
        return ok();
      });
      assert.equal(seen.length, 1);
      const { id, createdAt, ...got } = seen[0] as Request;
      assert.equal(typeof id, 'string');
      assert.equal(typeof createdAt, 'number');
      assert.deepEqual(got, body);
      assert.deepEqual(await requests.awaitReply(file), { ok: true });
    });
  }
});

describe('incoming contract boundaries', () => {
  it('refuses an incomplete versioned start rather than handing unknown fields to a handler', async () => {
    const file = await post({
      kind: 'remoteStartFilesV1',
      windowId: 'w1'
    } as unknown as RequestBody);
    let handled = false;
    await requests.claimRequests('w1', () => {
      handled = true;
      return ok();
    });
    assert.equal(handled, false);
    assert.deepEqual(await requests.awaitReply(file), { ok: false, reason: requests.MALFORMED });
  });

  it('bounds incoming-prefixed input before parsing while preserving large ordinary text', async () => {
    const text = 'x'.repeat(70_000);
    const ordinary = await post({ kind: 'send', windowId: 'w1', pid: 7, startedAt: 70, text });
    const incoming = path.join(dir(), 'incoming-large.request.json');
    await fs.writeFile(incoming, await fs.readFile(ordinary));
    const seen: string[] = [];
    await requests.claimRequests('w1', (request) => {
      seen.push(request.id);
      return ok();
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(await requests.awaitReply(ordinary), { ok: true });
  });
});

describe('versioned incoming requests and replies', () => {
  const f = incomingFixture;
  const start: RequestBody = {
    kind: 'remoteStartFilesV1',
    version: 1,
    windowId: 'w1',
    expectedHost: f.host,
    attempt: f.attempt,
    localRoot: path.resolve('/managed'),
    prompt: 'original text and manifest'
  };
  const bodies: RequestBody[] = [
    start,
    {
      kind: 'incomingEvidenceV1',
      version: 1,
      windowId: 'w1',
      expectedHost: f.host,
      challenge: f.OTHER_UUID,
      query: { kind: 'attempt', attempt: f.attempt }
    },
    { kind: 'fetchFile', version: 1, windowId: 'w0', ...f.fetchIdentity }
  ];

  it('uses bounded legacy-readable filenames and preserves exact versioned bodies through actual files', async () => {
    for (const body of bodies) {
      const file = await post(body);
      assert.match(path.basename(file), /^incoming-[a-f0-9-]+\.request\.json$/);
      const seen: Request[] = [];
      await requests.claimRequests(body.windowId, (request) => {
        seen.push(request);
        return { ok: false, incomingRefusal: 'unsupported-capability' };
      });
      const request = seen[0];
      assert.ok(request);
      const { id, createdAt, ...decoded } = request;
      assert.equal(requests.requestIdOf(file), id);
      assert.ok(Number.isSafeInteger(createdAt));
      assert.deepEqual(decoded, body);
      assert.equal((await requests.awaitReply(file))?.incomingRefusal, 'unsupported-capability');
    }
  });

  it('refuses missing, skewed and conflicting incoming fields without weakening legacy decoding', () => {
    for (const body of bodies) {
      const raw = { ...body, id: f.UUID, createdAt: 3000 };
      assert.ok(requestCodec.readRequest(raw)?.request);
      for (const change of [
        { version: undefined },
        { version: 2 },
        { windowId: 'wrong' },
        { createdAt: NaN },
        { id: 'not-uuid' }
      ])
        assert.equal(requestCodec.readRequest({ ...raw, ...change })?.request, undefined);
    }
    for (const change of [
      { expectedHost: { ...f.host, incarnation: f.OTHER_UUID } },
      { attempt: { ...f.attempt, selection: undefined } },
      { attempt: { ...f.attempt, target: {} } },
      { attempt: { ...f.attempt, admissionDigest: 'not-digest' } },
      { localRoot: '../unmanaged' },
      { prompt: '' }
    ])
      assert.equal(
        requestCodec.readRequest({ ...start, id: f.UUID, createdAt: 3000, ...change })?.request,
        undefined
      );
    assert.equal(
      requestCodec.readRequest({
        kind: 'open',
        id: 'legacy',
        createdAt: 1,
        windowId: 'w1',
        cwd: '/old'
      })?.request?.kind,
      'open'
    );
  });

  it('preserves ordinary text with an explicit denial sentinel for malformed optional incoming delivery', () => {
    const send = {
      kind: 'send',
      windowId: 'w1',
      pid: 7,
      startedAt: 70,
      text: 'keep text',
      correlation: 'correlation',
      id: 'legacy',
      createdAt: 1
    };
    for (const incomingDelivery of [
      null,
      { version: 99 },
      { ...f.delivery, correlation: 'another' },
      { ...f.delivery, receiver: { ...f.receiver, pid: 8 } }
    ]) {
      const request = requestCodec.readRequest({ ...send, incomingDelivery })?.request;
      assert.ok(request?.kind === 'send');
      assert.equal(request.text, 'keep text');
      assert.deepEqual(request.incomingDelivery, { version: 1, denied: 'admission-denied' });
    }
    const request = requestCodec.readRequest({ ...send, incomingDelivery: f.delivery })?.request;
    assert.ok(request?.kind === 'send');
    assert.deepEqual(request.incomingDelivery, f.delivery);
  });

  it('cannot turn an old or malformed success into fetched bytes or accepted evidence', async () => {
    for (const reply of [
      { ok: true },
      { ok: true, fetchFile: { version: 1, kind: 'fetched' } },
      { ok: true, remoteLaunchEvidence: { ...f.launch, stage: 'prepared' } },
      { ok: true, incomingEvidence: { version: 1 } }
    ]) {
      const file = await post(bodies[2]!);
      await fs.writeFile(file.replace('.request.json', '.reply.json'), JSON.stringify(reply));
      const decoded = await requests.awaitReply(file, 300);
      assert.equal(decoded?.ok, false);
      assert.ok(decoded?.incomingRefusal);
      await fs.rm(file, { force: true });
    }
    const wrongFile = await post(bodies[2]!);
    await fs.writeFile(
      wrongFile.replace('.request.json', '.reply.json'),
      JSON.stringify({
        ok: true,
        fetchFile: {
          version: 1,
          requestId: f.OTHER_UUID,
          identity: f.fetchIdentity,
          kind: 'fetched',
          cacheKey: 'provider_file',
          bytes: 0,
          localRoot: path.resolve('/managed'),
          path: path.resolve('/managed/file'),
          expiresAt: 5000
        }
      })
    );
    const wrongReply = await requests.awaitReply(wrongFile);
    assert.equal(
      wrongReply?.ok,
      false,
      'a valid receipt from another request cannot acknowledge this one'
    );
    assert.equal(wrongReply?.incomingRefusal, 'evidence-unavailable');
    await fs.rm(wrongFile, { force: true });
    const file = await post(bodies[2]!);
    await fs.writeFile(
      file.replace('.request.json', '.reply.json'),
      JSON.stringify({ ok: true, padding: 'x'.repeat(70_000) })
    );
    assert.equal(await requests.awaitReply(file, 200), undefined);
  });

  it('validates fetched, pending and refused replies with exact request IDs and bounded metadata', async () => {
    for (const kind of ['fetched', 'pending', 'refused'] as const) {
      const file = await post(bodies[2]!);
      const requestId = requests.requestIdOf(file);
      const fetchFile = {
        version: 1,
        requestId,
        identity: f.fetchIdentity,
        kind,
        ...(kind === 'fetched'
          ? {
              cacheKey: 'provider_file',
              bytes: 0,
              localRoot: path.resolve('/managed'),
              path: path.resolve('/managed/file'),
              expiresAt: 5000
            }
          : kind === 'pending'
            ? { retryable: true }
            : { code: 'closed' })
      };
      await fs.writeFile(
        file.replace('.request.json', '.reply.json'),
        JSON.stringify({ ok: kind === 'fetched', fetchFile })
      );
      assert.deepEqual((await requests.awaitReply(file))?.fetchFile, fetchFile);
      await fs.rm(file, { force: true });
    }
  });
});

it('rejects invalid UTF-8 in incoming request files before JSON can replace it', async () => {
  const file = await post({
    kind: 'fetchFile',
    version: 1,
    windowId: 'w0',
    ...incomingFixture.fetchIdentity
  });
  const bytes = await fs.readFile(file);
  const prefix = Buffer.from('"fileId":"');
  const offset = bytes.indexOf(prefix) + prefix.length;
  assert.ok(offset >= prefix.length);
  bytes[offset] = 0xff;
  await fs.writeFile(file, bytes);
  let served = false;
  await requests.claimRequests('w0', () => {
    served = true;
    return ok();
  });
  assert.equal(served, false);
  assert.equal(await requests.awaitReply(file, 200), undefined);
});

it('preserves ordinary text acknowledgments when optional incoming delivery is denied', async () => {
  for (const incomingDelivery of [
    null,
    { version: 1, denied: 'admission-denied' },
    { ...incomingFixture.delivery, correlation: 'different' }
  ]) {
    const file = await post({
      kind: 'send',
      windowId: 'w1',
      pid: 7,
      startedAt: 70,
      text: 'keep ordinary words',
      correlation: 'correlation',
      incomingDelivery
    } as unknown as RequestBody);
    assert.equal(path.basename(file).startsWith('incoming-'), false);
    await requests.claimRequests('w1', (request) => {
      assert.ok(request.kind === 'send');
      assert.equal(request.text, 'keep ordinary words');
      assert.deepEqual(request.incomingDelivery, { version: 1, denied: 'admission-denied' });
      return { ok: true, queued: 1 };
    });
    assert.deepEqual(await requests.awaitReply(file), { ok: true, queued: 1 });
  }
});
