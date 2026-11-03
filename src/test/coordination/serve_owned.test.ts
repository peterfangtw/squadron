import * as fixture from '../incoming_helpers';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionHandle } from '../../core/adapter';
import { refusal } from '../../core/adapter';
import type { Holder } from '../../core/remote/holder';
import { personAnswerProse } from '../../core/coordination/answer';
import type { Request, RequestBody } from '../../core/coordination/requests';
import { serveOwned, type RemoteStart, type ServePort } from '../../core/coordination/serve_owned';
import type { LiveState, PendingRequest } from '../../core/live';
import type { Decision, ImageBlock, SendTarget } from '../../core/model';

const PID = 7;
const STARTED = 70_000;
const HOLDER_WINDOW = 'w0';

const holder: Holder = {
  windowId: HOLDER_WINDOW,
  label: 'holder window',
  pid: 1234,
  startedAt: 1,
  since: 1
};

const state = (pending: PendingRequest[] = [], queued = 0): LiveState => ({
  cwd: '/work/app',
  startedAt: STARTED,
  status: 'busy',
  queued: Array.from({ length: queued }, (_, i) => ({ id: `q${i}`, text: '', queuedAt: 0 })),
  pending,
  running: true,
  turnsEnded: 0
});

const question: PendingRequest = {
  requestId: 'ask-1',
  toolName: 'AskUserQuestion',
  ask: true,
  questions: [{ question: 'Which colour?', header: 'Colour', options: [], multiSelect: false }]
};

const permission = (over: Partial<PendingRequest> = {}): PendingRequest => ({
  requestId: 'perm-1',
  toolName: 'Write',
  ask: false,
  ...over
});

type Sent = {
  text: string;
  images?: readonly ImageBlock[];
  describe?: string;
  ahead?: boolean;
  target?: SendTarget;
};

/** A handle that records what reached it, in the order it did. */
function handle(live: LiveState, over: Partial<SessionHandle> = {}) {
  const calls: string[] = [];
  const sent: Sent[] = [];
  const responses: { requestId: string; decision: Decision }[] = [];
  const owned: SessionHandle = {
    state: live,
    onChange: () => () => {},
    opening: Promise.resolve({ ok: true }),
    onActivity: () => () => {},
    close: () => {},
    readout: () => {},
    thread: {
      generation: () => 0,
      snapshot: () => ({
        conversation: '',
        generation: 0,
        history: { exchanges: [], firstSeen: new Map(), checkpoints: new Map() },
        recent: { exchanges: [], truncated: false },
        tail: []
      }),
      recovered: Promise.resolve(true),
      onChange: () => () => {}
    },
    messages: {
      images: true,
      pending: () => live.running || live.pending.length > 0 || live.queued.length > 0,
      send(text, images, describe, ahead, target) {
        calls.push('send');
        sent.push({ text, images, describe, ahead, target });
        live.queued.push({ id: `q${live.queued.length}`, text, queuedAt: 0 });
      },
      dismiss: () => false,
      sendNow() {
        calls.push('sendNow');
        live.queued.length = 0;
        return Promise.resolve();
      }
    },
    turn: {
      interrupt() {
        calls.push('interrupt');
        return Promise.resolve();
      }
    },
    asks: {
      respond(requestId, decision) {
        calls.push('respond');
        responses.push({ requestId, decision });
        return live.pending.some((open) => open.requestId === requestId);
      }
    },
    ...over
  };
  return { owned, calls, sent, responses };
}

function port(
  owned: SessionHandle | undefined,
  over: Partial<ServePort> = {}
): ServePort & { ended: [number, number][]; started: RemoteStart[] } {
  const ended: [number, number][] = [];
  const started: RemoteStart[] = [];
  return {
    ended,
    started,
    owned: (pid) => (pid === PID ? owned : undefined),
    end: (pid, startedAt) => {
      ended.push([pid, startedAt]);
      return true;
    },
    start: (start) => {
      started.push(start);
      return Promise.resolve({ ok: true, pid: 99, startedAt: 990, brand: start.brand ?? 'claude' });
    },
    holder: () => Promise.resolve(holder),
    ...over
  };
}

const envelope = (body: RequestBody): Request => ({ ...body, id: 'req-1', createdAt: 0 });

async function serve(body: RequestBody, served: ServePort) {
  const reply = serveOwned(envelope(body), served);
  assert.ok(reply, `${body.kind} is one serveOwned owns`);
  return reply;
}

const addr = { windowId: 'w1', pid: PID, startedAt: STARTED };

describe('serveOwned, what it owns', () => {
  it('leaves the host’s kinds to the host', () => {
    const bodies: RequestBody[] = [
      { kind: 'models', windowId: 'w1' },
      { kind: 'open', windowId: 'w1', cwd: '/tmp/x' },
      { kind: 'open', windowId: 'w1', cwd: '/tmp/x', prompt: 'go' },
      { ...addr, kind: 'send', text: 'hi', via: 'verb', from: 's' },
      { ...addr, kind: 'answer', askId: 'ask-1', text: 'blue' },
      { ...addr, kind: 'rename', title: 'new' }
    ];
    const { owned } = handle(state());
    for (const body of bodies) {
      assert.equal(serveOwned(envelope(body), port(owned)), undefined, body.kind);
    }
  });

  it('leaves a warm to the host, beside rename', () => {
    const { owned } = handle(state());
    const body: RequestBody = { ...addr, kind: 'warm', on: true };
    assert.equal(serveOwned(envelope(body), port(owned)), undefined);
  });

  it('leaves an attach to the holder’s arm, though it names a pid', () => {
    const body: RequestBody = {
      ...addr,
      kind: 'attach',
      sessionWindowId: 'w2',
      path: '/work/app/plot.png',
      from: 's'
    };
    const { owned } = handle(state());
    assert.equal(serveOwned(envelope(body), port(owned)), undefined);
  });

  it('answers a pid-carrying kind this build does not know as an older Squadron', async () => {
    const { owned } = handle(state());
    const future = { ...addr, kind: 'teleport' } as unknown as RequestBody;
    const reply = await serve(future, port(owned));
    assert.equal(reply.ok, false);
    assert.match(reply.reason ?? '', /older Squadron/);
  });

  it('refuses a pid it does not hold, and one at another start', async () => {
    const { owned } = handle(state());
    const elsewhere = await serve({ ...addr, kind: 'close', pid: 8 }, port(owned));
    assert.deepEqual(elsewhere, {
      ok: false,
      reason: 'This window does not drive that session.',
      closeFailure: 'unavailable'
    });
    const recycled = await serve(
      { ...addr, kind: 'interrupt', startedAt: STARTED + 60_000, remote: HOLDER_WINDOW },
      port(owned)
    );
    assert.deepEqual(recycled, { ok: false, reason: 'That session is no longer there.' });
  });
});

describe('serveOwned, the composer send and close', () => {
  it('keeps legacy composer sends while explicit Remote sends require the current holder', async () => {
    const { owned, sent } = handle(state());
    const absent = port(owned, { holder: () => Promise.resolve(undefined) });
    const legacy: RequestBody = { ...addr, kind: 'send', text: 'legacy', from: 'older-shim' };
    assert.equal((await serve(legacy, absent)).ok, true);
    assert.equal(sent.length, 1);
    for (const remote of ['other-holder', HOLDER_WINDOW]) {
      const reply = await serve({ ...legacy, origin: 'remote', remote }, absent);
      assert.equal(reply.ok, false);
      assert.equal(reply.reason, 'Remote is off.');
      assert.equal(sent.length, 1);
    }
    const active = port(owned);
    assert.equal(
      (await serve({ ...legacy, origin: 'remote', remote: 'other-holder' }, active)).ok,
      false
    );
    assert.equal(sent.length, 1);
    assert.equal(
      (await serve({ ...legacy, origin: 'remote', remote: HOLDER_WINDOW }, active)).ok,
      true
    );
    assert.equal(sent.length, 2);
    assert.equal((await serve({ ...legacy, origin: 'composer' }, absent)).ok, true);
    assert.equal(sent.length, 3);
  });

  it('refuses conflicting explicit origin even through the raw serving facade', async () => {
    const { owned, sent } = handle(state());
    const body = {
      ...addr,
      kind: 'send',
      text: 'do not deliver',
      via: 'verb',
      origin: 'composer'
    } as RequestBody;
    assert.deepEqual(await serveOwned(envelope(body), port(owned)), {
      ok: false,
      reason: 'That request could not be read.'
    });
    assert.equal(sent.length, 0);
  });

  it('puts a composer send on the pipe and says how deep the outbox is left', async () => {
    const live = state([], 1);
    const { owned, sent } = handle(live);
    const images = [{ mediaType: 'image/png', data: 'AAAA' }];
    const reply = await serve(
      { ...addr, kind: 'send', text: 'hello', images, target: { model: 'm' } },
      port(owned)
    );
    assert.deepEqual(sent, [
      { text: 'hello', images, describe: undefined, ahead: undefined, target: { model: 'm' } }
    ]);
    assert.deepEqual(reply, { ok: true, queued: 2 });
  });

  it('reads a send to an idle session as on the pipe while its drain is still behind the capture', async () => {
    // The handle drains behind a baseline capture (`tryDrain`), so the
    // message is still in the outbox when the send returns. Counted as held,
    // every reply to an idle session from a phone came back as "busy".
    const live = { ...state(), status: 'idle' as const, running: false };
    const { owned } = handle(live);
    const reply = await serve({ ...addr, kind: 'send', text: 'hello' }, port(owned));
    assert.equal(live.queued.length, 1, 'the fake drains nothing, as a capturing handle does');
    assert.deepEqual(reply, { ok: true, queued: 0 });
  });

  it('acknowledges an overlapping close while its session is still ending', async () => {
    const served = port(undefined, {
      ending: (pid, startedAt) => pid === PID && startedAt === STARTED
    });
    assert.deepEqual(await serve({ ...addr, kind: 'close' }, served), { ok: true });
    assert.deepEqual(served.ended, []);
  });

  it('refuses an End with a nearby but different canonical start time', async () => {
    const { owned } = handle(state());
    const served = port(owned);
    const reply = await serve({ ...addr, startedAt: STARTED + 1_000, kind: 'close' }, served);
    assert.equal(reply.ok, false);
    assert.equal(reply.closeFailure, 'gone');
    assert.deepEqual(served.ended, []);
  });

  it('does not acknowledge a close the owner failed to accept', async () => {
    const { owned } = handle(state());
    const reply = await serve({ ...addr, kind: 'close' }, port(owned, { end: () => false }));
    assert.equal(reply.ok, false);
  });

  it('ends a session through the port, at the start it was asked for', async () => {
    const { owned } = handle(state());
    const served = port(owned);
    assert.deepEqual(await serve({ ...addr, kind: 'close' }, served), { ok: true });
    assert.deepEqual(served.ended, [[PID, STARTED]]);
  });
});

describe('serveOwned, the Remote guard', () => {
  const legacyGuarded: RequestBody[] = [
    { ...addr, kind: 'interrupt', remote: HOLDER_WINDOW },
    { ...addr, kind: 'deny', requestId: 'perm-1', remote: HOLDER_WINDOW },
    { ...addr, kind: 'personAnswer', askId: 'ask-1', text: 'blue', remote: HOLDER_WINDOW },
    {
      kind: 'open',
      windowId: 'w1',
      cwd: '/tmp/x',
      prompt: 'go',
      via: 'remote',
      remote: HOLDER_WINDOW
    }
  ];

  const guarded = legacyGuarded.flatMap((body) => [body, { ...body, origin: 'remote' as const }]);

  it('refuses every guarded kind when no live holder exists', async () => {
    for (const body of guarded) {
      const { owned, calls } = handle(state([question, permission()]));
      const served = port(owned, { holder: () => Promise.resolve(undefined) });
      assert.deepEqual(
        await serve(body, served),
        { ok: false, reason: 'Remote is off.' },
        body.kind
      );
      assert.deepEqual(calls, [], `${body.kind} reached the session`);
      assert.deepEqual(served.started, [], `${body.kind} started a session`);
    }
  });

  it('refuses every guarded kind sent on behalf of a window that is not the holder', async () => {
    for (const body of guarded) {
      const { owned, calls } = handle(state([question, permission()]));
      const served = port(owned);
      const forged = { ...body, remote: 'someone-else' } as RequestBody;
      assert.deepEqual(await serve(forged, served), { ok: false, reason: 'Remote is off.' });
      assert.deepEqual(calls, []);
      assert.deepEqual(served.started, []);
    }
  });

  it('refuses a guarded kind that names no holder at all, while a holder is live', async () => {
    // By kind, not by whether the field is there: a file written without
    // `remote` would otherwise pass a guard that only ran when it was present.
    for (const body of guarded.filter((one) => one.kind !== 'open')) {
      const { owned, calls } = handle(state([question, permission()]));
      const served = port(owned);
      const { remote: _, ...bare } = body as RequestBody & { remote: string };
      assert.deepEqual(
        await serve(bare as RequestBody, served),
        { ok: false, reason: 'Remote is off.' },
        body.kind
      );
      assert.deepEqual(calls, [], `${body.kind} reached the session`);
    }
  });

  it('refuses a Remote open that names no holder at all (R4)', async () => {
    // Otherwise `via: 'remote'` would be an ungated, uncounted spawn path for
    // anything that can write a request file.
    const served = port(undefined);
    const bare: RequestBody = {
      kind: 'open',
      windowId: 'w1',
      cwd: '/tmp/x',
      prompt: 'go',
      via: 'remote'
    };
    assert.deepEqual(await serve(bare, served), { ok: false, reason: 'Remote is off.' });
    assert.deepEqual(served.started, []);
  });
});

describe('serveOwned, interrupt', () => {
  it('ends the turn in flight', async () => {
    const { owned, calls } = handle(state());
    assert.deepEqual(
      await serve({ ...addr, kind: 'interrupt', remote: HOLDER_WINDOW }, port(owned)),
      {
        ok: true
      }
    );
    assert.deepEqual(calls, ['interrupt']);
  });

  it('says there is nothing to stop when no turn runs, and interrupts nothing', async () => {
    // Status is live: the window holding the pipe decides, never a board.
    const { owned, calls } = handle({ ...state(), status: 'idle', running: false });
    assert.deepEqual(
      await serve({ ...addr, kind: 'interrupt', remote: HOLDER_WINDOW }, port(owned)),
      { ok: true, idle: true }
    );
    assert.deepEqual(calls, []);
  });

  it('refuses a session whose turn cannot be ended', async () => {
    const { owned } = handle(state(), { turn: undefined });
    assert.deepEqual(
      await serve({ ...addr, kind: 'interrupt', remote: HOLDER_WINDOW }, port(owned)),
      {
        ok: false,
        reason: refusal('turn')
      }
    );
  });
});

describe('serveOwned, deny', () => {
  it('denies even when the request carries a forged allow', async () => {
    // Nothing on the wire is read as a decision (D18): the window builds the
    // refusal itself.
    const { owned, responses } = handle(state([permission()]));
    const forged = {
      ...addr,
      kind: 'deny',
      requestId: 'perm-1',
      reason: 'not that file',
      remote: HOLDER_WINDOW,
      decision: { allow: true }
    } as RequestBody;
    assert.deepEqual(await serve(forged, port(owned)), { ok: true });
    assert.deepEqual(responses, [
      { requestId: 'perm-1', decision: { allow: false, message: 'not that file' } }
    ]);
  });

  it('drops the reason for a request that cannot carry one', async () => {
    const { owned, responses } = handle(state([permission({ canDenyReason: false })]));
    await serve(
      { ...addr, kind: 'deny', requestId: 'perm-1', reason: 'why', remote: HOLDER_WINDOW },
      port(owned)
    );
    assert.deepEqual(responses, [{ requestId: 'perm-1', decision: { allow: false } }]);
  });

  it('refuses a request that is no longer open, without answering anything', async () => {
    const { owned, calls } = handle(state([]));
    const reply = await serve(
      { ...addr, kind: 'deny', requestId: 'perm-1', remote: HOLDER_WINDOW },
      port(owned)
    );
    assert.equal(reply.ok, false);
    assert.deepEqual(calls, []);
  });
});

describe('serveOwned, personAnswer', () => {
  it('delivers ahead and then drains, while the question is open', async () => {
    const { owned, calls, sent } = handle(state([question]));
    const reply = await serve(
      {
        ...addr,
        kind: 'personAnswer',
        askId: 'ask-1',
        text: 'the blue one',
        remote: HOLDER_WINDOW
      },
      port(owned)
    );
    assert.deepEqual(calls, ['send', 'sendNow']);
    assert.equal(sent[0]?.text, personAnswerProse('the blue one'));
    assert.equal(sent[0]?.describe, 'the blue one');
    assert.equal(sent[0]?.ahead, true);
    assert.deepEqual(reply, { ok: true, queued: 0 });
  });

  it('sends a closed question’s answer as an ordinary message, never dropping it', async () => {
    const { owned, calls, sent } = handle(state([]));
    const reply = await serve(
      {
        ...addr,
        kind: 'personAnswer',
        askId: 'ask-1',
        text: 'the blue one',
        remote: HOLDER_WINDOW
      },
      port(owned)
    );
    assert.deepEqual(calls, ['send']);
    assert.equal(sent[0]?.text, 'the blue one');
    assert.notEqual(sent[0]?.ahead, true);
    assert.deepEqual(reply, { ok: true, queued: 1 });
  });

  it('does not interrupt for a question answered on its dialog meanwhile', async () => {
    // The second `stillOpen` check: the person may click the dialog while the
    // send is awaited, and an interrupt then would cut the turn their click
    // began. The words stay held for the idle edge.
    const live = state([question]);
    const { owned, calls } = handle(live, {});
    const messages = owned.messages;
    assert.ok(messages);
    const racing: SessionHandle = {
      ...owned,
      messages: {
        ...messages,
        send(...args) {
          live.pending = [];
          return messages.send(...args);
        }
      }
    };
    const reply = await serve(
      { ...addr, kind: 'personAnswer', askId: 'ask-1', text: 'blue', remote: HOLDER_WINDOW },
      port(racing)
    );
    assert.deepEqual(calls, ['send']);
    assert.deepEqual(reply, { ok: true, queued: 1 });
  });

  it('words its lead line with none of the fake CLIs’ trigger words', () => {
    // A prompt is a prompt: "ask" in a lead line opens a question dialog in
    // `fake-cli` that nobody wanted (M2 Notes → Gotchas).
    const lead = personAnswerProse('').toLowerCase();
    for (const trigger of [
      'ask',
      'two',
      'write',
      'slow',
      'linger',
      'quiet',
      'spool',
      'origin',
      'whoami',
      'entrypoint',
      'perm',
      'request',
      'hang'
    ]) {
      assert.equal(lead.includes(trigger), false, trigger);
    }
  });
});

describe('serveOwned, a Remote open', () => {
  it('starts through the port with no request id, so no lineage is written', async () => {
    const served = port(undefined);
    const reply = await serve(
      {
        kind: 'open',
        windowId: 'w1',
        cwd: '/tmp/x',
        prompt: 'tidy the readme',
        name: 'readme',
        via: 'remote',
        remote: HOLDER_WINDOW,
        brand: 'grok'
      },
      served
    );
    assert.deepEqual(served.started, [
      { cwd: '/tmp/x', prompt: 'tidy the readme', name: 'readme', brand: 'grok' }
    ]);
    assert.deepEqual(reply, { ok: true, pid: 99, startedAt: 990, brand: 'grok' });
  });

  it('refuses a future named brand before starting, and preserves an absent brand', async () => {
    const base = {
      kind: 'open' as const,
      windowId: 'w1',
      cwd: '/tmp/x',
      via: 'remote' as const,
      remote: HOLDER_WINDOW
    };
    const served = port(undefined);
    assert.deepEqual(await serve({ ...base, brand: 'future' }, served), {
      ok: false,
      reason: 'That CLI cannot be started from here.',
      cause: 'pick'
    });
    assert.deepEqual(served.started, []);
    const selected = await serve({ ...base, brand: 'future', selection: 'catalog' }, served);
    assert.equal(selected.ok, false);
    assert.equal(selected.notStarted, true);
    assert.equal(selected.selectionInvalid, true);
    assert.deepEqual(served.started, []);
    assert.equal((await serve(base, served)).ok, true);
    assert.deepEqual(served.started, [{ cwd: '/tmp/x' }]);
  });

  it('passes a refused start back as it came', async () => {
    const served = port(undefined, {
      start: () =>
        Promise.resolve({ ok: false, reason: 'No `grok` executable found.', cause: 'pick' })
    });
    const reply = await serve(
      {
        kind: 'open',
        windowId: 'w1',
        cwd: '/tmp/x',
        prompt: 'go',
        via: 'remote',
        remote: HOLDER_WINDOW
      },
      served
    );
    assert.deepEqual(reply, { ok: false, reason: 'No `grok` executable found.', cause: 'pick' });
  });
});

describe('incoming arms require negotiated owner services', () => {
  it('refuses starts and evidence before any child, holder or owned lookup', async () => {
    const f = fixture;
    const bodies: RequestBody[] = [
      {
        kind: 'remoteStartFilesV1',
        version: 1,
        windowId: 'w1',
        expectedHost: f.host,
        attempt: f.attempt,
        localRoot: f.receiver.cwd,
        prompt: 'go'
      },
      {
        kind: 'incomingEvidenceV1',
        version: 1,
        windowId: 'w1',
        expectedHost: f.host,
        challenge: f.OTHER_UUID,
        query: { kind: 'attempt', attempt: f.attempt }
      }
    ];
    const unused = (): never => {
      throw new Error('unwired contract reached a service');
    };
    const p: ServePort = { owned: unused, end: unused, start: unused, holder: unused };
    for (const body of bodies.flatMap<RequestBody>((one) =>
      one.kind === 'remoteStartFilesV1' ? [one, { ...one, origin: 'remote' as const }] : [one]
    )) {
      const reply = await serve(body, p);
      assert.equal(reply.ok, false);
      assert.equal(reply.incomingRefusal, 'unsupported-capability');
      assert.equal(reply.notStarted, body.kind === 'remoteStartFilesV1' ? true : undefined);
    }
    const future = { ...bodies[0], kind: 'remoteStartFilesV2' } as unknown as RequestBody;
    assert.match((await serve(future, p)).reason ?? '', /older Squadron/);
  });

  it('refuses an enforced delivery envelope while malformed optional access leaves text delivery legal', async () => {
    const { owned, sent } = handle(state());
    const served = port(owned);
    const send: RequestBody = {
      ...addr,
      kind: 'send',
      text: 'words',
      correlation: fixture.delivery.correlation,
      incomingDelivery: fixture.delivery
    };
    for (const body of [send, { ...send, origin: 'remote' as const, remote: HOLDER_WINDOW }]) {
      const reply = await serve(body, served);
      assert.equal(reply.incomingRefusal, 'unsupported-capability');
      assert.equal(sent.length, 0);
    }
    const denied = await serve(
      { ...send, incomingDelivery: { version: 1, denied: 'admission-denied' } },
      served
    );
    assert.equal(denied.ok, true);
    assert.equal(sent[0]?.text, 'words');
  });

  it('does not let explicit Remote origin replace incoming holder-generation proof', async () => {
    const { owned, sent } = handle(state());
    let admitted = 0;
    const served = port(owned, {
      incomingHolder: () => Promise.resolve({ ...holder, incoming: fixture.holder }),
      deliverIncoming: async (_pid, _delivery, _outcome, send) => {
        admitted++;
        return send();
      }
    });
    const body: RequestBody = {
      ...addr,
      kind: 'send',
      origin: 'remote',
      remote: HOLDER_WINDOW,
      text: 'files',
      correlation: fixture.delivery.correlation,
      incomingDelivery: fixture.delivery
    };
    for (const incomingHolder of [undefined, { ...fixture.holder, generation: 2 }]) {
      const reply = await serve({ ...body, incomingHolder }, served);
      assert.equal(reply.incomingRefusal, 'remote-off');
      assert.equal(admitted, 0);
      assert.equal(sent.length, 0);
    }
    assert.equal((await serve({ ...body, incomingHolder: fixture.holder }, served)).ok, true);
    assert.equal(admitted, 1);
    assert.equal(sent.length, 1);
  });

  it('routes fetch to the holder without borrowing the receiving pipe lookup', () => {
    const fetch = envelope({
      kind: 'fetchFile',
      version: 1,
      windowId: 'w0',
      ...fixture.fetchIdentity
    });
    assert.equal(serveOwned(fetch, port(undefined)), undefined);
  });
});
