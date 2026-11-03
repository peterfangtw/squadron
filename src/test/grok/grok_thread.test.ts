import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import * as path from 'node:path';

import { after, before, describe, it } from 'node:test';

import type { SessionHandle } from '../../core/adapter';

let wrapMessage: (typeof import('../../core/coordination/send'))['wrapMessage'];

let wrapWait: (typeof import('../../core/coordination/send'))['wrapWait'];

import {
  adapter,
  converged,
  dispose,
  drawn,
  Grok,
  grokTranscript,
  opened,
  record,
  recorded,
  sent,
  setup,
  start,
  tick,
  until
} from './grok_session_helpers';

before(async () => {
  await setup();
  ({ wrapMessage } = await import('../../core/coordination/send'));
  ({ wrapWait } = await import('../../core/coordination/send'));
});

after(dispose);

describe('our own record of a Grok session', () => {
  it('writes the echoed prompt and the answer, with the prompt ordinal on the turn', async () => {
    const handle = start();
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    handle.messages?.send('record-me');
    await until(handle, 'the answer', (s) => s.words.includes('pong'));
    // Keyed on this case's own prompt, not on `pong`: every session here is
    // `g1`, so a `pong` from an earlier case is already in the file.
    const lines = await recorded((all) => all.some((line) => line.text === 'record-me'));

    assert.deepEqual(
      lines[0],
      { v: record.SCHEMA, sessionId: 'g1', cwd: '/tmp/project', brand: 'grok' },
      'header names the session, directory and brand'
    );
    await recorded((all) => all.some((line) => line.role === 'assistant' && line.text === 'pong'));
    const mine = lines.filter((line) => line.text === 'record-me');
    assert.equal(mine.length, 1, 'the echo is the turn, and the drain does not write a second');
    const { at, ...turn } = mine[0] ?? {};
    assert.equal(typeof at, 'number', 'stamped with when the echo reached us');
    assert.deepEqual(turn, {
      role: 'user',
      text: 'record-me',
      blocks: [{ text: 'record-me' }],
      // On the turn's own line. A bare `{m}` after it would resolve to the
      // *next* turn — `24ca63d` in the other spelling.
      m: '0'
    });
  });

  it('does not write the turns a `session/load` replays', async () => {
    // Production hands a resumed session its id before the child speaks
    // (`host/sessions.ts`), so these lines are recordable and the tee's drop is
    // the only thing standing between the record and a doubled conversation.
    const handle = start({ resume: 'g1', sessionId: 'g1' });
    await until(handle, 'the load', (s) => s.sessionId === 'g1');
    handle.messages?.send('after-load');
    await until(handle, 'the answer', (s) => s.words.includes('pong'));
    const lines = await recorded((all) => all.some((line) => line.text === 'after-load'));
    assert.equal(
      lines.filter((line) => line.text === 'replayed').length,
      0,
      'the replayed chunk is already in `chat_history.jsonl`'
    );
  });

  it('puts the pictures the drain copied onto the turn the echo wrote', async () => {
    // The copy is started at the drain and awaited inside the append queue,
    // because the echo that mints the user turn can beat a file write back.
    // Nothing asserted the merge before: dropping it left every other case
    // green while a Grok card drew a YOU with no pictures on it.
    const handle = start();
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    handle.messages?.send('look at this', [{ mediaType: 'image/png', data: 'aGVsbG8=' }]);
    await until(handle, 'the answer', (s) => s.words.includes('saw-1-image'));
    const lines = await recorded((all) =>
      all.some((line) => line.text === 'look at this' && Array.isArray(line.images))
    );
    const turn = lines.find((line) => line.text === 'look at this');
    const images = turn?.images as { id: string; mediaType?: string }[] | undefined;
    assert.equal(images?.length, 1);
    // Our own copy (`r|`), not the path Grok wrote into `<image_files>` (`p|`).
    assert.match(images?.[0]?.id ?? '', /^r\|g1-/);
    assert.equal(images?.[0]?.mediaType, 'image/png');
  });

  /** Sends peer, wait and typed-with-a-picture messages as one merged prompt. */
  async function mergedDelivery(handle: SessionHandle, tag: string): Promise<void> {
    handle.messages?.send('slow please');
    await until(handle, 'the thought', (s) => s.status === 'busy');
    handle.messages?.send(wrapMessage(`${tag} peer words`, `${tag}-peer`));
    handle.messages?.send(wrapWait(`${tag} wait words`));
    handle.messages?.send(`${tag} mine`, [{ mediaType: 'image/png', data: 'aGVsbG8=' }]);
    await handle.messages?.sendNow();
    await until(handle, 'the merged prompt', (s) => s.queued.length === 0);
  }

  function deliveredTurns(lines: readonly Record<string, unknown>[], tag: string) {
    const first = lines.findIndex((line) => line.text === `${tag} peer words`);
    return lines.slice(first, first + 3).map((line) => ({
      role: line.role,
      text: line.text,
      from: line.from,
      images: Array.isArray(line.images) ? line.images.length : undefined,
      witnessed: typeof line.m === 'string'
    }));
  }

  const expected = (tag: string) => [
    {
      role: 'user',
      text: `${tag} peer words`,
      from: `${tag}-peer`,
      images: undefined,
      witnessed: true
    },
    {
      role: 'wait',
      text: `${tag} wait words`,
      from: undefined,
      images: undefined,
      witnessed: false
    },
    { role: 'user', text: `${tag} mine`, from: undefined, images: 1, witnessed: false }
  ];

  it('records a merged prompt echoed live as one turn per message', async () => {
    const handle = start();
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    await mergedDelivery(handle, 'gbl');
    const lines = await recorded((all) => all.some((line) => line.text === 'gbl mine'));
    assert.deepEqual(deliveredTurns(lines, 'gbl'), expected('gbl'));
    assert.equal(
      lines.filter((line) => typeof line.text === 'string' && line.text.includes('gbl')).length,
      3,
      'the later chunks of the same echo add nothing'
    );
  });

  it('records a merged prompt Grok wrote only to disk as one turn per message', async (t) => {
    const now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const handle = start({
      env: { SQUADRON_FAKE_ACP_NO_USER_ECHO: '1', SQUADRON_FAKE_ACP_ECHO_AT_MS: String(now) }
    });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    await mergedDelivery(handle, 'gbd');
    const lines = await recorded((all) => all.some((line) => line.text === 'gbd mine'));
    assert.deepEqual(deliveredTurns(lines, 'gbd'), expected('gbd'));
    assert.equal(
      lines.filter((line) => typeof line.text === 'string' && line.text.includes('gbd')).length,
      3
    );
  });

  for (const offset of [-3, 2]) {
    it(`records each merged message once with a disk echo offset of ${offset} ms`, async (t) => {
      const now = Date.now();
      t.mock.method(Date, 'now', () => now);
      const handle = start({
        env: {
          SQUADRON_FAKE_ACP_NO_USER_ECHO: '1',
          SQUADRON_FAKE_ACP_ECHO_AT_MS: String(now + offset)
        }
      });
      await until(handle, 'handshake', (s) => s.sessionId === 'g1');
      const tag = `boundary${offset}`;
      await mergedDelivery(handle, tag);
      const lines = await recorded((all) => all.some((line) => line.text === `${tag} mine`));
      assert.deepEqual(deliveredTurns(lines, tag), expected(tag));
      assert.equal(
        lines.filter((line) => typeof line.text === 'string' && line.text.includes(tag)).length,
        3
      );
    });
  }

  it('files what an ask answered onto the call it rode in on, through a read back', async () => {
    const handle = start({ skipPermissions: false });
    await until(handle, 'handshake', (s) => s.sessionId === 'g1');
    handle.messages?.send('ask please');
    const waiting = await until(handle, 'the dialog', (s) => s.pending.length === 1);
    const request = waiting.pending[0];
    assert.ok(request);
    // Picks nobody else in this file makes: the fake mints one `call-ask-1`
    // and the record is shared, so the answer is what identifies this case's.
    handle.asks?.respond(request.requestId, { allow: true, picks: [[1], [1]] });
    await until(handle, 'idle after the answer', (s) => s.pending.length === 0 && !s.running);

    // **Asserted after `readRecord`, not off the raw lines.** An ask is a tool
    // call here, so at the moment it is answered the assistant line carrying
    // that call is still open — and a `{ret}` written ahead of that line is
    // dropped by the fold, silently. Reading the file back is the only place
    // that is visible, which is how the first build passed a raw-line check
    // while losing every Grok ask answer.
    const picked = JSON.stringify({
      'Which route should we take?': 'Right',
      'Which pace?': ['Steady']
    });
    // Polled on the **read record**, not on a line matching some text: the
    // options ride the call's own `rawInput`, so every string in this answer is
    // already in the file before the answer is.
    const answers = async (): Promise<string[]> =>
      ((await record.readRecord('g1'))?.exchanges ?? [])
        .flatMap((turn) => ('blocks' in turn ? (turn.blocks ?? []) : []))
        .flatMap((block) => ('call' in block ? [block.call] : []))
        .filter((call) => call.id === 'call-ask-1' && call.ask)
        .map((call) => JSON.stringify(call.ask?.answers));
    for (let i = 0; i < 100 && !(await answers()).includes(picked); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(
      (await answers()).includes(picked),
      'the answer survives the fold, on the call the ask rode in on'
    );
  });
});

describe('a Grok session on its thread', () => {
  it('settles a named historical prompt without closing the newer prompt', async () => {
    const { wire, handle } = await opened();
    assert.ok(handle.messages);
    handle.messages.send('same words', [], undefined, false, undefined, 'a');
    for (let i = 0; i < 200 && wire.prompts().length < 1; i++) await tick(5);
    const a = wire.prompts()[0];
    assert.ok(a);
    wire.reply(a, { stopReason: 'future-stop' });
    await until(handle, 'A unclassified', (s) => !s.running);
    assert.deepEqual(handle.state.messageFacts, [{ correlation: 'a', phase: 'unknown' }]);
    handle.messages.send('same words', [], undefined, false, undefined, 'b');
    for (let i = 0; i < 200 && wire.prompts().length < 2; i++) await tick(5);
    const b = wire.prompts()[1];
    assert.ok(b);
    const before = {
      status: handle.state.status,
      running: handle.state.running,
      inFlight: handle.state.inFlight,
      turnsEnded: handle.state.turnsEnded,
      lastOutcome: handle.state.lastOutcome
    };
    wire.completed(a.promptId, 'end_turn');
    assert.deepEqual(handle.state.messageFacts, [
      { correlation: 'a', phase: 'done' },
      { correlation: 'b', phase: 'processing' }
    ]);
    assert.deepEqual(
      {
        status: handle.state.status,
        running: handle.state.running,
        inFlight: handle.state.inFlight,
        turnsEnded: handle.state.turnsEnded,
        lastOutcome: handle.state.lastOutcome
      },
      before
    );
    wire.reply(b, { stopReason: 'cancelled' });
    await until(handle, 'B cut', (s) => !s.running);
    wire.completed(b.promptId, 'end_turn');
    assert.deepEqual(handle.state.messageFacts, [
      { correlation: 'a', phase: 'done' },
      { correlation: 'b', phase: 'unsuccessful' }
    ]);
  });
  it('keeps a wake whose close was lost apart from the reply after it, echoed only on disk', async () => {
    const { wire, handle } = await opened();
    // Grok wakes itself: the queue names a turn we never sent, its prose
    // streams, and its `turn_completed` never arrives.
    wire.running('task-wake');
    wire.chunk('wake words', 100, 'task-wake');
    await until(handle, 'the wake is running', (s) => s.running);
    const prompt = await sent(wire, handle, 'ours please');
    // Grok 1.0.41 writes our prompt's echo to `updates.jsonl` and not the pipe.
    const transcript = handle.state.transcript;
    assert.ok(transcript);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(
      path.join(path.dirname(transcript), 'updates.jsonl'),
      JSON.stringify({
        timestamp: Math.floor(Date.now() / 1000),
        method: 'session/update',
        params: {
          sessionId: wire.id,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'ours please' },
            _meta: { promptIndex: 1 }
          },
          _meta: { agentTimestampMs: Date.now() }
        }
      }) + '\n'
    );
    wire.running(prompt.promptId);
    wire.chunk('our reply', 200, prompt.promptId);
    wire.completed(prompt.promptId, 'end_turn');
    wire.reply(prompt, { stopReason: 'end_turn' });
    await until(handle, 'our turn ends', (s) => !s.running && s.queued.length === 0);
    await converged(wire, handle);
    assert.deepEqual(drawn(handle), [
      'assistant: wake words',
      'user: ours please',
      'assistant: our reply'
    ]);
  });
  it('lands a turn once however many of its closers arrive, and ignores a close for another turn', async () => {
    const { wire, handle } = await opened();
    const first = await sent(wire, handle, 'first question');
    wire.echo('first question', 0);
    wire.chunk('first answer', 100, first.promptId);
    wire.completed(first.promptId, 'error', 'first failed');
    wire.promptComplete(first.promptId, 'error', 'first failed');
    wire.reply(first, { stopReason: 'error' });
    await until(handle, 'the first turn ends', (s) => !s.running);

    const second = await sent(wire, handle, 'second question');
    wire.echo('second question', 1);
    wire.chunk('part one', 200, second.promptId);
    // The first turn's close again, late, and a close for a turn nobody here
    // sent: neither is the second message's end, nor a second alarm.
    wire.completed(first.promptId, 'error', 'first failed');
    wire.completed('someone-else', 'end_turn');
    assert.deepEqual(
      handle.thread.snapshot().tail.map((row) => row.exchange.text),
      ['part one'],
      'the second message is still being written'
    );
    wire.chunk(' part two', 200, second.promptId);
    wire.completed(second.promptId, 'end_turn');
    wire.reply(second, { stopReason: 'end_turn' });
    await until(handle, 'the second turn ends', (s) => !s.running && s.queued.length === 0);
    await converged(wire, handle);
    assert.deepEqual(drawn(handle), [
      'user: first question',
      'assistant: first answer [cut]',
      'cli: first failed',
      'user: second question',
      'assistant: part one part two'
    ]);
  });
  it('closes a turn whose only closer is the reply', async () => {
    const { wire, handle } = await opened();
    const done = await sent(wire, handle, 'reply only');
    wire.echo('reply only', 0);
    wire.chunk('all of it', 100, done.promptId);
    wire.reply(done, { stopReason: 'end_turn' });
    await until(handle, 'the turn ends', (s) => !s.running);
    const cancelled = await sent(wire, handle, 'cancel me');
    wire.echo('cancel me', 1);
    wire.chunk('some of', 200, cancelled.promptId);
    wire.reply(cancelled, { stopReason: 'cancelled' });
    await until(handle, 'the turn ends', (s) => !s.running && s.queued.length === 0);
    // The reply is the last closer: the cut row is on disk now, well inside the
    // thread's own deadline, or memory and the record would disagree here.
    await converged(wire, handle);
    assert.deepEqual(drawn(handle), [
      'user: reply only',
      'assistant: all of it',
      'user: cancel me',
      'assistant: some of [cut]',
      '[break]'
    ]);
  });
  it('cuts the message Send now interrupts, and keeps its late chunk off the next turn', async () => {
    const { wire, handle } = await opened();
    const long = await sent(wire, handle, 'long one');
    wire.echo('long one', 0);
    wire.chunk('half of', 100, long.promptId);
    handle.messages.send('urgent');
    const before = wire.prompts().length;
    await handle.messages.sendNow?.();
    for (let i = 0; i < 200 && wire.prompts().length === before; i++) await tick(5);
    const urgent = wire.prompts()[before];
    assert.ok(urgent, 'Send now wrote the held message');
    // The cancelled stream's last chunk, after the close and naming no prompt.
    const beforeLate = handle.state;
    wire.chunk(' it', 100);
    assert.equal(handle.state, beforeLate, 'the late chunk changes no card state');
    wire.reply(long, { stopReason: 'cancelled' });
    wire.echo('urgent', 1);
    wire.chunk('on it', 200, urgent.promptId);
    wire.completed(urgent.promptId, 'end_turn');
    wire.reply(urgent, { stopReason: 'end_turn' });
    await until(handle, 'the urgent turn ends', (s) => !s.running && s.queued.length === 0);
    await converged(wire, handle);
    assert.deepEqual(drawn(handle), [
      'user: long one',
      'assistant: half of it [cut]',
      '[break]',
      'user: urgent',
      'assistant: on it'
    ]);
  });
  for (const queuedOnWire of [false, true]) {
    it(`marks a Send now interrupt of a Grok wake once${queuedOnWire ? ' with our prompt queued on the wire' : ''}`, async () => {
      const { wire, handle } = await opened();
      const wake = 'task-completed-interrupt';
      wire.running(wake);
      wire.chunk('wake partial', 100, queuedOnWire ? wake : undefined);
      await until(handle, 'the wake is running', (state) => state.running);
      const queued = queuedOnWire ? await sent(wire, handle, 'waiting behind wake') : undefined;
      handle.messages.send('urgent after wake');
      await handle.messages.sendNow();
      assert.equal(handle.thread.snapshot().tail.length, 0, 'Send now closes the wake output');
      wire.completed(wake, 'cancelled');
      wire.completed(wake, 'cancelled');
      if (queued) {
        wire.completed(queued.promptId, 'cancelled');
        wire.promptComplete(queued.promptId, 'cancelled', '');
        wire.reply(queued, { stopReason: 'cancelled' });
      }
      await until(
        handle,
        'the urgent prompt',
        (state) => state.inFlight?.text === 'urgent after wake'
      );
      const urgent = wire.prompts().find((prompt) => prompt.text === 'urgent after wake');
      assert.ok(urgent);
      wire.echo('urgent after wake', queuedOnWire ? 1 : 0);
      wire.chunk('urgent reply', 200, urgent.promptId);
      wire.completed(urgent.promptId, 'end_turn');
      wire.reply(urgent, { stopReason: 'end_turn' });
      await until(
        handle,
        'the urgent reply ends',
        (state) => !state.running && state.queued.length === 0
      );
      handle.close();
      await converged(wire, handle);
      const exchanges = handle.thread.snapshot().recent.exchanges;
      assert.equal(
        exchanges.filter((exchange) => 'mark' in exchange && exchange.mark === 'break').length,
        1
      );
      assert.ok(
        exchanges.some(
          (exchange) => 'role' in exchange && exchange.text === 'wake partial' && exchange.cut
        )
      );
      const divider = exchanges.findIndex(
        (exchange) => 'mark' in exchange && exchange.mark === 'break'
      );
      const nextPrompt = exchanges.findIndex(
        (exchange) => 'role' in exchange && exchange.text === 'urgent after wake'
      );
      assert.ok(divider < nextPrompt, 'the divider stays before the urgent prompt');
    });
  }

  describe('a sent prompt Grok never echoes', () => {
    it('flush waits for echo reads, including a send started during its wait', async () => {
      const { wire, handle } = await opened();
      const first = await sent(wire, handle, 'first while flushing');
      wire.chunk('first answer', 100, first.promptId);
      const original = grokTranscript.readSentUserUpdate;
      const releases: (() => void)[] = [];
      const reading = new Set<string>();
      const reached = new Map<string, () => void>();
      const firstRead = new Promise<void>((resolve) =>
        reached.set('first while flushing', resolve)
      );
      const secondRead = new Promise<void>((resolve) =>
        reached.set('second while flushing', resolve)
      );
      grokTranscript.readSentUserUpdate = (file, at, text, settled) => {
        if (file !== handle.state.transcript || reading.has(text)) {
          return original(file, at, text, settled);
        }
        reading.add(text);
        reached.get(text)?.();
        return new Promise((resolve) => releases.push(() => resolve(undefined)));
      };
      let flushed = false;
      try {
        wire.reply(first, { stopReason: 'end_turn' });
        await firstRead;
        const flush = handle.flush().then(() => {
          flushed = true;
        });
        const second = await sent(wire, handle, 'second while flushing');
        wire.chunk('second answer', 200, second.promptId);
        wire.reply(second, { stopReason: 'end_turn' });
        await secondRead;
        releases[0]?.();
        await tick(50);
        assert.equal(flushed, false, 'flush still owes the second echo worker');
        releases[1]?.();
        await flush;
        assert.deepEqual(drawn(handle), [
          'user: first while flushing',
          'assistant: first answer',
          'user: second while flushing',
          'assistant: second answer'
        ]);
        await converged(wire, handle);
      } finally {
        grokTranscript.readSentUserUpdate = original;
        for (const release of releases) release();
        handle.close();
      }
    });

    it('close and flush wait for an echo read before persisting a partial reply', async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'closing during echo read');
      wire.chunk('partial reply', 100, prompt.promptId);
      const original = grokTranscript.readSentUserUpdate;
      let release = (): void => {};
      let reading = false;
      let reached = (): void => {};
      const readStarted = new Promise<void>((resolve) => {
        reached = resolve;
      });
      grokTranscript.readSentUserUpdate = (file, at, text, settled) => {
        if (file !== handle.state.transcript || reading) {
          return original(file, at, text, settled);
        }
        reading = true;
        reached();
        return new Promise((resolve) => {
          release = () => resolve(undefined);
        });
      };
      let flushed = false;
      try {
        handle.close();
        await readStarted;
        const flush = handle.flush().then(() => {
          flushed = true;
        });
        await tick(50);
        assert.equal(flushed, false, 'shutdown still owes the held echo read');
        release();
        await flush;
        assert.deepEqual(drawn(handle), [
          'user: closing during echo read',
          'assistant: partial reply [cut]'
        ]);
        await converged(wire, handle);
      } finally {
        grokTranscript.readSentUserUpdate = original;
        release();
        wire.reply(prompt, { stopReason: 'cancelled' });
        handle.close();
      }
    });

    it('is kept when the turn completes', async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'no echo');
      wire.chunk('answer', 100, prompt.promptId);
      wire.completed(prompt.promptId, 'end_turn');
      wire.reply(prompt, { stopReason: 'end_turn' });
      await until(handle, 'the turn ends', (s) => !s.running && s.queued.length === 0);
      await converged(wire, handle);
      assert.deepEqual(drawn(handle), ['user: no echo', 'assistant: answer']);
    });

    it('is kept when the turn is interrupted', async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'stop me');
      wire.chunk('some of', 100, prompt.promptId);
      wire.completed(prompt.promptId, 'cancelled');
      wire.promptComplete(prompt.promptId, 'cancelled', '');
      wire.reply(prompt, { stopReason: 'cancelled' });
      await until(handle, 'the turn ends', (s) => !s.running && s.queued.length === 0);
      await converged(wire, handle);
      assert.deepEqual(drawn(handle), ['user: stop me', 'assistant: some of [cut]', '[break]']);
    });

    it('is kept when the child dies mid-reply', async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'then it died');
      wire.chunk('partial', 100, prompt.promptId);
      wire.exit();
      await converged(wire, handle);
      assert.deepEqual(drawn(handle), ['user: then it died', 'assistant: partial [cut]']);
    });

    it('keeps the pictures its copy lands after the reply', async () => {
      const { wire, handle } = await opened();
      const before = wire.prompts().length;
      handle.messages.send('look', [{ mediaType: 'image/png', data: 'aGVsbG8=' }]);
      for (let i = 0; i < 200 && wire.prompts().length === before; i++) await tick(5);
      const prompt = wire.prompts()[before];
      assert.ok(prompt);
      wire.reply(prompt, { stopReason: 'end_turn' });
      await until(handle, 'the turn ends', (s) => !s.running && s.queued.length === 0);
      await converged(wire, handle);
      const [turn] = handle.thread.snapshot().history.exchanges;
      assert.ok(turn && 'role' in turn && turn.role === 'user' && turn.text === 'look');
      assert.equal(turn.images?.length, 1, 'its copy rides the turn');
    });

    it('keeps failed dispatch cache-neutral and advances on confirmed traffic', async () => {
      const { wire, handle } = await opened();
      let cacheAt = 1000;
      let wasRunning = handle.state.running;
      let activityChanges = 0;
      handle.onChange((state, origin, cacheTraffic) => {
        if (
          adapter.advancesActivityClock({ origin, status: state.status, turned: true, warm: false })
        )
          activityChanges++;
        if (
          adapter.advancesCacheClock({ origin, running: state.running, wasRunning, cacheTraffic })
        )
          cacheAt++;
        wasRunning = state.running;
      });
      handle.onActivity(() => {
        if (
          adapter.advancesCacheClock({ origin: 'agent', running: handle.state.running, wasRunning })
        )
          cacheAt++;
      });
      wire.refuse = true;
      handle.messages.send('never sent');
      await until(handle, 'failed dispatch ends', (s) => !s.running && s.queued.length === 0);
      await converged(wire, handle);
      assert.equal(cacheAt, 1000);
      assert.ok(activityChanges > 0, 'the existing real-activity policy still sees dispatch');

      wire.refuse = false;
      const prompt = await sent(wire, handle, 'successful');
      assert.equal(cacheAt, 1000, 'dispatch is not confirmed API traffic');
      wire.chunk('OK', 100, prompt.promptId);
      assert.ok(cacheAt > 1000);
      const beforeEnd = cacheAt;
      wire.completed(prompt.promptId, 'end_turn');
      wire.reply(prompt, { stopReason: 'end_turn' });
      await until(handle, 'confirmed turn ends', (s) => !s.running && s.queued.length === 0);
      assert.ok(cacheAt > beforeEnd);
    });

    it('is not recorded when its write never left', async () => {
      const { wire, handle } = await opened();
      wire.refuse = true;
      handle.messages.send('never sent');
      await until(handle, 'the turn ends', (s) => !s.running && s.queued.length === 0);
      await converged(wire, handle);
      assert.deepEqual(drawn(handle), []);
    });
  });
  describe("the sent prompt's echo, late", () => {
    it('lands on the slot its send took, above the reply it came after', async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'question');
      wire.chunk('reply before echo', 100, prompt.promptId);
      wire.echo('question', 0);
      wire.chunk(' and after', 100, prompt.promptId);
      wire.completed(prompt.promptId, 'end_turn');
      wire.reply(prompt, { stopReason: 'end_turn' });
      await until(handle, 'the turn ends', (s) => !s.running && s.queued.length === 0);
      await converged(wire, handle);
      assert.deepEqual(drawn(handle), ['user: question', 'assistant: reply before echo and after']);
      const read = await record.readRecordLines(wire.id);
      const asked = read?.lines.find((line) => 'role' in line && line.role === 'user');
      assert.ok(asked && 'm' in asked);
      assert.equal(asked.m, '0', 'the echo is its witness');
    });

    it('leaves a tool batch it arrives after on its row', async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'run it');
      wire.chunk('running', 100, prompt.promptId);
      wire.update(
        { sessionUpdate: 'tool_call', toolCallId: 'call-u1-0', title: 'run_terminal_command' },
        { streamStartMs: 100, promptId: prompt.promptId }
      );
      wire.echo('run it', 0);
      wire.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-u1-0',
        status: 'completed'
      });
      wire.chunk('done', 200, prompt.promptId);
      wire.completed(prompt.promptId, 'end_turn');
      wire.reply(prompt, { stopReason: 'end_turn' });
      await until(handle, 'the turn ends', (s) => !s.running && s.queued.length === 0);
      await converged(wire, handle);
      assert.deepEqual(drawn(handle), ['user: run it', 'assistant: running', 'assistant: done']);
      const calls = handle.thread
        .snapshot()
        .history.exchanges.flatMap((x) => ('blocks' in x ? (x.blocks ?? []) : []))
        .flatMap((block) => ('call' in block ? [block.call.id] : []));
      assert.deepEqual(calls, ['call-u1-0']);
    });
  });
  describe("a cut stream's late text", () => {
    it('lands on its cut row while the next prompt streams, and opens no row', async () => {
      const { wire, handle } = await opened();
      const first = await sent(wire, handle, 'first');
      wire.echo('first', 0);
      wire.chunk('half', 100, first.promptId);
      handle.messages.send('second');
      const before = wire.prompts().length;
      await handle.messages.sendNow?.();
      for (let i = 0; i < 200 && wire.prompts().length === before; i++) await tick(5);
      const second = wire.prompts()[before];
      assert.ok(second);
      wire.echo('second', 1);
      wire.chunk('new reply', 200, second.promptId);
      wire.chunk(' old suffix', 100);
      assert.deepEqual(
        handle.thread.snapshot().tail.map((row) => row.exchange.text),
        ['new reply'],
        'the second reply is still being written, and the old text is not a row'
      );
      wire.reply(first, { stopReason: 'cancelled' });
      await tick();
      // Sealed by its reply: text after it is nobody's.
      const settled = handle.state;
      wire.chunk(' stale', 100);
      assert.equal(handle.state, settled, 'stale text changes no card state');
      wire.chunk(' more', 200, second.promptId);
      wire.completed(second.promptId, 'end_turn');
      wire.reply(second, { stopReason: 'end_turn' });
      await until(handle, 'the second turn ends', (s) => !s.running && s.queued.length === 0);
      await converged(wire, handle);
      assert.deepEqual(drawn(handle), [
        'user: first',
        'assistant: half old suffix [cut]',
        '[break]',
        'user: second',
        'assistant: new reply more'
      ]);
    });
  });
  it('says a live chunk is the agent at work, and a late or stale one is not', async () => {
    const { wire, handle } = await opened();
    let spoke = 0;
    handle.onActivity(() => spoke++);
    const prompt = await sent(wire, handle, 'first');
    wire.echo('first', 0);
    wire.chunk('half', 100, prompt.promptId);
    const open = handle.state;
    wire.chunk(' more', 100, prompt.promptId);
    assert.equal(handle.state, open, 'no card state moved');
    assert.equal(spoke, 2);
    wire.completed(prompt.promptId, 'cancelled');
    wire.chunk(' late', 100);
    wire.reply(prompt, { stopReason: 'cancelled' });
    await tick();
    wire.chunk(' stale', 100);
    assert.equal(spoke, 2);
  });
  describe("the CLI's alarm", () => {
    const alarms = (handle: Grok): string[] =>
      handle.thread
        .snapshot()
        .history.exchanges.flatMap((x) => ('role' in x && x.role === 'cli' ? [x.text] : []));

    it('says a rate limit once, in its own words, however many closers state it', async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'limited');
      wire.echo('limited', 0);
      wire.completed(prompt.promptId, 'rate_limit', 'Usage limit reached');
      wire.promptComplete(prompt.promptId, 'rate_limit', 'Usage limit reached');
      wire.reply(prompt, { stopReason: 'rate_limit' });
      await until(handle, 'the turn ends', (s) => !s.running);
      await converged(wire, handle);
      assert.deepEqual(alarms(handle), ['Usage limit reached']);
      assert.equal(handle.state.lastOutcome, 'error', 'as the card says it');
    });

    it('says an error the reply alone states, with words of its own', async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'fails quietly');
      wire.echo('fails quietly', 0);
      wire.chunk('started', 100, prompt.promptId);
      wire.reply(prompt, { stopReason: 'error' });
      await until(handle, 'the turn ends', (s) => !s.running);
      await converged(wire, handle);
      assert.deepEqual(alarms(handle), ['The turn ended with an error.']);
      assert.deepEqual(drawn(handle).slice(-2), [
        'assistant: started [cut]',
        'cli: The turn ended with an error.'
      ]);
    });

    it("takes prompt_complete's words when the reply carries none", async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'payment');
      wire.echo('payment', 0);
      wire.promptComplete(prompt.promptId, 'error', 'API error (status 402)');
      wire.reply(prompt, { stopReason: 'error' });
      await until(handle, 'the turn ends', (s) => !s.running);
      await converged(wire, handle);
      assert.deepEqual(alarms(handle), ['API error (status 402)']);
    });

    it('says the error a refused prompt came back with', async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'refused');
      wire.fail(prompt, { code: -32000, message: 'Internal error', data: 'Model overloaded' });
      await until(handle, 'the turn ends', (s) => !s.running);
      await converged(wire, handle);
      assert.deepEqual(alarms(handle), ['Model overloaded']);
      assert.equal(handle.state.lastOutcome, 'error');
    });

    it("restates a wordless first closer's alarm in a later closer's words", async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'broke');
      wire.echo('broke', 0);
      wire.completed(prompt.promptId, 'error');
      assert.deepEqual(alarms(handle), ['The turn ended with an error.'], 'said at once');
      wire.promptComplete(prompt.promptId, 'error', 'API error (status 402)');
      wire.reply(prompt, { stopReason: 'error' });
      await until(handle, 'the turn ends', (s) => !s.running);
      await converged(wire, handle);
      assert.deepEqual(alarms(handle), ['API error (status 402)']);
    });

    it("restates it in a refused prompt's error data", async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'overloaded');
      wire.echo('overloaded', 0);
      wire.completed(prompt.promptId, 'error');
      wire.fail(prompt, { code: -32000, message: 'Internal error', data: 'Model overloaded' });
      await until(handle, 'the turn ends', (s) => !s.running);
      await converged(wire, handle);
      assert.deepEqual(alarms(handle), ['Model overloaded']);
    });

    it('says nothing for a completed or cancelled turn', async () => {
      const { wire, handle } = await opened();
      const prompt = await sent(wire, handle, 'fine');
      wire.echo('fine', 0);
      wire.completed(prompt.promptId, 'cancelled');
      wire.promptComplete(prompt.promptId, 'cancelled', '');
      wire.reply(prompt, { stopReason: 'cancelled' });
      await until(handle, 'the turn ends', (s) => !s.running);
      await converged(wire, handle);
      assert.deepEqual(alarms(handle), []);
      assert.deepEqual(drawn(handle), ['user: fine', '[break]']);
    });
  });
});
