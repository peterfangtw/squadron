import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import { after, describe, it } from 'node:test';

import type { Exchange } from '../../core/transcript';

import type { ImageBlock } from '../../core/model';

let CodexSession: (typeof import('../../core/codex/session'))['CodexSession'];

let readRecord: (typeof import('../../core/record'))['readRecord'];

let recordFile: (typeof import('../../core/record'))['recordFile'];

type CodexSession = import('../../core/codex/session').CodexSession;

import { before } from 'node:test';

import { alive, dispose, setup, ThreadPeer, threadSession, until } from './codex_session_helpers';

before(async () => {
  await setup();
  ({ CodexSession } = await import('../../core/codex/session'));
  ({ readRecord } = await import('../../core/record'));
  ({ recordFile } = await import('../../core/record'));
});

after(dispose);

describe('Codex on the shared thread', () => {
  it('settles a named historical message without closing the newer turn', async () => {
    const { peer, handle } = await threadSession();
    peer.holding.add('turn/start');
    handle.messages.send('same words', [], undefined, false, undefined, 'a');
    await peer.sent('turn/start');
    peer.reply('turn/start', { result: { turn: { id: 'a' } } });
    await until(handle, 'confirmed A', (s) => s.inFlight !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    peer.notify('turn/completed', { turn: { id: 'a', status: 'future-status' } });
    assert.deepEqual(handle.state.messageFacts, [{ correlation: 'a', phase: 'unknown' }]);
    handle.messages.send('same words', [], undefined, false, undefined, 'b');
    await until(handle, 'B written', (s) => s.inFlight !== undefined && s.queued.length === 0);
    peer.reply('turn/start', { result: { turn: { id: 'b' } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = {
      status: handle.state.status,
      running: handle.state.running,
      inFlight: handle.state.inFlight,
      turnsEnded: handle.state.turnsEnded,
      lastOutcome: handle.state.lastOutcome
    };
    peer.notify('turn/completed', { turn: { id: 'a', status: 'completed' } });
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
    peer.notify('turn/completed', { turn: { id: 'b', status: 'interrupted' } });
    peer.notify('turn/completed', { turn: { id: 'b', status: 'completed' } });
    assert.deepEqual(handle.state.messageFacts, [
      { correlation: 'a', phase: 'done' },
      { correlation: 'b', phase: 'unsuccessful' }
    ]);
  });
  it('streams two messages under their item ids and closes each in the same tick', async () => {
    const { peer, handle } = await threadSession();
    const empty = handle.thread.snapshot();
    peer.delta('commentary', 'Checking');
    const first = handle.thread.snapshot();
    assert.equal(first.history, empty.history);
    assert.deepEqual(
      first.tail.map((row) => [row.id, row.exchange.text]),
      [['commentary', 'Checking']]
    );
    peer.delta('commentary', ' the files.');
    assert.equal(first.tail[0]?.exchange.text, 'Checking', 'earlier snapshots stay immutable');
    peer.completed('commentary', 'Checking the files.');
    assert.equal(handle.thread.snapshot().tail.length, 0);
    peer.delta('final', 'All');
    peer.delta('final', ' done.');
    const streaming = handle.thread.snapshot();
    assert.equal(streaming.recent.exchanges.length, 1);
    assert.deepEqual(
      streaming.tail.map((row) => [row.id, row.exchange.text]),
      [['final', 'All done.']]
    );
    peer.completed('final', 'All done.');
    peer.notify('turn/completed', { turn: { id: 'turn-a', status: 'completed' } });
    await handle.flush();
    const shot = handle.thread.snapshot();
    assert.equal(shot.tail.length, 0);
    assert.deepEqual(
      shot.recent.exchanges.map((x) => 'text' in x && x.text),
      ['Checking the files.', 'All done.']
    );
    assert.deepEqual(shot.history.exchanges, (await readRecord(peer.id))?.exchanges);
    const rows = (await fs.readFile(recordFile(peer.id), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { m?: string });
    assert.deepEqual(
      rows.flatMap((row) => (row.m ? [row.m] : [])),
      ['commentary', 'final']
    );
  });
  it('keeps identical messages distinct and duplicate completions silent', async () => {
    const { peer, handle } = await threadSession();
    for (const id of ['first', 'second']) {
      peer.delta(id, 'Same words.');
      peer.completed(id, 'Same words.');
      const before = handle.thread.snapshot();
      peer.completed(id, 'Same words.');
      assert.equal(handle.thread.snapshot(), before);
    }
    await handle.flush();
    assert.equal(handle.thread.snapshot().recent.exchanges.length, 2);
  });
  it('cuts all received deltas at an interrupted completion with no completed agent item', async () => {
    const { peer, handle } = await threadSession();
    peer.notify('turn/started', { turn: { id: 'turn-a' } });
    peer.delta('partial', 'One');
    peer.delta('partial', ' two three');
    await handle.interrupt();
    assert.equal(
      handle.thread.snapshot().tail.length,
      1,
      'the interrupt acknowledgement alone is not a close'
    );
    peer.notify('turn/completed', { turn: { id: 'turn-a', status: 'interrupted' } });
    const cut = handle.thread.snapshot();
    assert.equal(cut.tail.length, 0);
    assert.deepEqual(
      cut.recent.exchanges.map((x) => ('text' in x ? [x.text, x.cut] : x.mark)),
      [['One two three', true], 'break']
    );
    peer.delta('partial', ' lost', 'turn-a');
    peer.notify('turn/completed', { turn: { id: 'turn-a', status: 'interrupted' } });
    await handle.flush();
    assert.deepEqual(
      handle.thread.snapshot().history.exchanges,
      (await readRecord(peer.id))?.exchanges
    );
    assert.equal(handle.thread.snapshot().recent.exchanges.length, 2);
  });
  it('filters cross-thread notifications and never cuts a different turn', async () => {
    const { peer, handle } = await threadSession();
    peer.delta('own', 'Our words', 'turn-b');
    const before = handle.thread.snapshot();
    peer.notify('item/agentMessage/delta', {
      threadId: 'other',
      itemId: 'foreign',
      delta: 'Foreign words'
    });
    peer.notify('item/completed', {
      threadId: 'other',
      item: { type: 'agentMessage', id: 'own', text: 'Foreign words' }
    });
    peer.notify('turn/completed', {
      threadId: 'other',
      turn: { id: 'turn-b', status: 'interrupted' }
    });
    assert.equal(handle.thread.snapshot(), before);
    peer.notify('turn/completed', { turn: { id: 'turn-a', status: 'interrupted' } });
    assert.deepEqual(
      handle.thread.snapshot().tail.map((row) => row.exchange.text),
      ['Our words']
    );
    peer.completed('own', 'Our words', 'turn-b');
    await handle.flush();
    assert.deepEqual(
      handle.thread.snapshot().history.exchanges,
      (await readRecord(peer.id))?.exchanges
    );
  });
  it('waits for stdout close and includes a delta buffered after process exit', async () => {
    const { peer, handle } = await threadSession();
    peer.delta('killed', 'Before');
    peer.exit();
    assert.equal(handle.thread.snapshot().tail.length, 1);
    peer.delta('killed', ' and buffered');
    peer.end();
    peer.end();
    await handle.flush();
    const shot = handle.thread.snapshot();
    assert.equal(shot.tail.length, 0);
    assert.deepEqual(
      shot.recent.exchanges.map((x) => 'text' in x && [x.text, x.cut]),
      [['Before and buffered', true]]
    );
    assert.deepEqual(shot.history.exchanges, (await readRecord(peer.id))?.exchanges);
  });
  it('leaves a pending start’s message open past the exit until stdout drains', async () => {
    const { peer, handle } = await threadSession();
    peer.holding.add('turn/start');
    handle.messages?.send('Question');
    await peer.sent('turn/start');
    peer.delta('killed', 'Before');
    peer.exit();
    // The exit rejects the pending start; its catch runs before stdout drains.
    await new Promise((resolve) => setImmediate(resolve));
    peer.delta('killed', ' and buffered');
    peer.end();
    await handle.flush();
    const shot = handle.thread.snapshot();
    assert.equal(shot.tail.length, 0);
    assert.deepEqual(
      shot.recent.exchanges.flatMap((x) =>
        'role' in x && x.role === 'assistant' ? [[x.text, x.cut]] : []
      ),
      [['Before and buffered', true]]
    );
    assert.deepEqual(shot.history.exchanges, (await readRecord(peer.id))?.exchanges);
  });
  it('still cuts the open message when a start fails with the child alive', async () => {
    const { peer, handle } = await threadSession();
    peer.holding.add('turn/start');
    handle.messages?.send('Question');
    await peer.sent('turn/start');
    peer.delta('open', 'Received');
    peer.reply('turn/start', { result: {} });
    await until(handle, 'the failed start to end the turn', (state) => !state.inFlight);
    peer.delta('open', ' dropped');
    await handle.flush();
    assert.deepEqual(
      handle.thread
        .snapshot()
        .recent.exchanges.flatMap((x) =>
          'role' in x && x.role === 'assistant' ? [[x.text, x.cut]] : []
        ),
      [['Received', true]]
    );
  });
  describe('a sent question Codex never echoes', () => {
    async function asked(text = 'Question', images: ImageBlock[] = []) {
      const { peer, handle } = await threadSession();
      peer.holding.add('turn/start');
      handle.messages?.send(text, images);
      await peer.sent('turn/start');
      return { peer, handle };
    }

    async function kept(peer: ThreadPeer, handle: CodexSession): Promise<Exchange[]> {
      await handle.flush();
      const shot = handle.thread.snapshot();
      assert.equal(shot.tail.length, 0);
      assert.deepEqual(shot.history.exchanges, (await readRecord(peer.id))?.exchanges ?? []);
      return shot.recent.exchanges.filter((x) => !('mark' in x));
    }

    function said(exchanges: readonly Exchange[]): unknown[] {
      return exchanges.map((x) => ('role' in x ? [x.role, x.text, !!x.cut] : x));
    }

    it('is drawn the moment it is sent', async () => {
      const { handle } = await asked();
      assert.deepEqual(said(handle.thread.snapshot().recent.exchanges), [
        ['user', 'Question', false]
      ]);
    });

    for (const status of ['interrupted', 'failed', 'completed']) {
      it(`is kept when its turn ends ${status}`, async () => {
        const { peer, handle } = await asked();
        peer.reply('turn/start', { result: { turn: { id: 'turn-a' } } });
        peer.notify('turn/started', { turn: { id: 'turn-a' } });
        peer.delta('reply', 'Answer');
        peer.notify('turn/completed', { turn: { id: 'turn-a', status } });
        await until(handle, 'the turn to end', (state) => !state.inFlight);
        assert.equal(handle.state.inFlight, undefined);
        assert.deepEqual(said(await kept(peer, handle)), [
          ['user', 'Question', false],
          ['assistant', 'Answer', true],
          ...(status === 'failed' ? [['cli', 'Codex turn failed.', false]] : [])
        ]);
      });
    }

    it('is kept when the child dies mid-reply', async () => {
      const { peer, handle } = await asked();
      peer.reply('turn/start', { result: { turn: { id: 'turn-a' } } });
      peer.delta('reply', 'Half');
      peer.exit();
      peer.end();
      assert.deepEqual(said(await kept(peer, handle)), [
        ['user', 'Question', false],
        ['assistant', 'Half', true]
      ]);
    });

    it('keeps its picture', async () => {
      const { peer, handle } = await asked('Look', [
        { mediaType: 'image/png', data: Buffer.from('png').toString('base64') }
      ]);
      peer.reply('turn/start', { result: { turn: { id: 'turn-a' } } });
      peer.notify('turn/completed', { turn: { id: 'turn-a', status: 'interrupted' } });
      const [question] = await kept(peer, handle);
      assert.ok(question && 'role' in question);
      assert.equal(question.text, 'Look');
      assert.equal(question.images?.length, 1);
    });

    it('takes its echo as a witness, once', async () => {
      const { peer, handle } = await asked();
      peer.reply('turn/start', { result: { turn: { id: 'turn-a' } } });
      peer.delta('reply', 'Answer');
      peer.notify('item/completed', {
        turnId: 'turn-a',
        item: {
          type: 'userMessage',
          id: 'user-item',
          clientId: peer.params.get('turn/start')?.clientUserMessageId,
          content: [{ type: 'text', text: 'Question' }]
        }
      });
      peer.completed('reply', 'Answer');
      peer.notify('turn/completed', { turn: { id: 'turn-a', status: 'completed' } });
      assert.deepEqual(said(await kept(peer, handle)), [
        ['user', 'Question', false],
        ['assistant', 'Answer', false]
      ]);
      const rows = (await fs.readFile(recordFile(peer.id), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { m?: string; role?: string });
      assert.equal(rows.find((row) => row.role === 'user')?.m, 'user-item');
    });

    it('is not recorded when Codex refuses to start its turn', async () => {
      const { peer, handle } = await asked();
      peer.reply('turn/start', { error: { code: -32600, message: 'refused' } });
      await until(handle, 'the refused start to end the turn', (state) => !state.inFlight);
      assert.deepEqual(said(await kept(peer, handle)), []);
    });
  });
  it('says each delta is the agent at work, never a checkpoint or a finished turn', async () => {
    const { peer, handle } = await threadSession();
    let spoke = 0;
    handle.onActivity(() => spoke++);
    peer.notify('turn/started', { turn: { id: 'turn-a' } });
    peer.delta('reply', 'One');
    const open = handle.state;
    peer.delta('reply', ' two');
    assert.equal(handle.state, open, 'no card state moved');
    assert.equal(spoke, 2);
    peer.notify('turn/completed', { turn: { id: 'turn-a', status: 'interrupted' } });
    peer.delta('reply', ' after', 'turn-a');
    await handle.flush();
    assert.equal(spoke, 2, 'the turn’s end, its checkpoint and later text are not');
  });
  it('records completed items without deltas, including merged user echoes', async () => {
    const { peer, handle } = await threadSession();
    peer.notify('item/completed', {
      item: { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'Asked' }] }
    });
    peer.completed('reply', 'Answered');
    handle.readout('Local reply');
    await handle.flush();
    const shot = handle.thread.snapshot();
    assert.deepEqual(
      shot.recent.exchanges.map((x) => 'text' in x && x.text),
      ['Asked', 'Answered', 'Local reply']
    );
    assert.deepEqual(shot.history.exchanges, (await readRecord(peer.id))?.exchanges);
  });
  it('cuts on systemError but lets an error notification await its terminal frame', async () => {
    const { peer, handle } = await threadSession();
    peer.delta('open', 'Received');
    peer.notify('error', { message: 'Still retrying', willRetry: true });
    assert.equal(handle.thread.snapshot().tail.length, 1);
    peer.delta('open', ' words');
    peer.notify('thread/status/changed', { status: { type: 'systemError' } });
    peer.notify('turn/completed', { turn: { id: 'turn-a', status: 'failed' } });
    await handle.flush();
    const shot = handle.thread.snapshot();
    assert.equal(shot.tail.length, 0);
    assert.ok(
      shot.recent.exchanges.some((x) => 'text' in x && x.text === 'Received words' && x.cut)
    );
    assert.deepEqual(shot.history.exchanges, (await readRecord(peer.id))?.exchanges);
  });
  it('ends at process exit when a transport has no stdout-close callback', async () => {
    const peer = new ThreadPeer();
    delete peer.transport.onEnd;
    const handle = new CodexSession(peer.transport, { cwd: '/tmp/codex-project', startedAt: 1 });
    alive.push(handle);
    assert.deepEqual(await handle.opening, { ok: true });
    peer.delta('open', 'Received words');
    peer.exit();
    await handle.flush();
    assert.equal(handle.thread.snapshot().tail.length, 0);
    assert.ok(handle.thread.snapshot().recent.exchanges.some((x) => 'text' in x && x.cut));
  });
  for (const status of ['completed', 'failed']) {
    it(`cuts an uncompleted agent item when a turn ends ${status}`, async () => {
      const { peer, handle } = await threadSession();
      peer.delta('open', 'Received words');
      peer.notify('turn/completed', { turn: { id: 'turn-a', status } });
      await handle.flush();
      const shot = handle.thread.snapshot();
      assert.equal(shot.tail.length, 0);
      assert.ok(
        shot.recent.exchanges.some((x) => 'text' in x && x.text === 'Received words' && x.cut)
      );
      assert.deepEqual(shot.history.exchanges, (await readRecord(peer.id))?.exchanges);
    });
  }
});
