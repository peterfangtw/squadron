import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import { after, before, describe, it } from 'node:test';

import {
  alive,
  claude,
  ClaudeSession,
  dispose,
  dying,
  Line,
  nowhere,
  outbox,
  record,
  setup,
  stub,
  Transport,
  turnStarted
} from './claude_session_helpers';

before(async () => {
  await setup();
});

after(dispose);

/**
 * The conversation in memory, fed off the pipe frame by frame: what the dock
 * will draw from once it stops reading the record back.
 */
describe('the thread, fed off the pipe', () => {
  type Owned = InstanceType<ClaudeSession['OwnedSession']>;

  /** A root message's stream, or a subagent's when `parent` names its call. */
  const event = (body: Line, parent?: string): Line => ({
    type: 'stream_event',
    event: body,
    parent_tool_use_id: parent ?? null
  });
  const started = (id: string, parent?: string): Line =>
    event({ type: 'message_start', message: { id, model: 'claude-opus-5' } }, parent);
  const block = (index: number, parent?: string): Line =>
    event(
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      parent
    );
  const delta = (index: number, text: string, parent?: string): Line =>
    event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, parent);
  /** One block's completing frame. */
  const said = (id: string, text: string, more: Line = {}): Line => ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
    ...more
  });

  function opened(conversation: string, rig: { transport: Transport } = stub()): Owned {
    const session = new claude.OwnedSession(rig.transport, {
      cwd: nowhere,
      startedAt: 1000,
      sessionId: conversation
    });
    alive.push(session);
    return session;
  }

  const drawn = (session: Owned) => {
    const shot = session.thread.snapshot();
    return {
      turns: shot.recent.exchanges.map((x) =>
        'role' in x ? [x.role, x.text, x.cut ?? false] : [x.mark]
      ),
      tail: shot.tail.map((row) => [row.id, row.exchange.text])
    };
  };

  /** The record's lines as written, `m` and `cut` included. */
  async function lines(conversation: string): Promise<Line[]> {
    const raw = await fs.readFile(record.recordFile(conversation), 'utf8').catch(() => '');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Line)
      .filter((line) => !('v' in line));
  }

  it('marks only its own background task’s end, across the turn that started it', async () => {
    // `cli_state/claude/subagent_cmd_2026_10_14/`: the session's start, then a
    // subagent's, then the turn's `result`, and both ends after it.
    const id = 'tasks-1111-2222-3333-444444444444';
    const rig = stub();
    const session = opened(id, rig);
    const task = (subtype: string, task_id: string, more: Line = {}): Line => ({
      type: 'system',
      subtype,
      task_id,
      tool_use_id: `toolu_${task_id}`,
      session_id: id,
      ...more
    });
    rig.answer(task('task_started', 'own', { is_backgrounded: true, task_type: 'local_bash' }));
    rig.answer(
      task('task_started', 'child', {
        is_backgrounded: true,
        task_type: 'local_bash',
        owned_by_subagent: true,
        parent_task_id: 'agent'
      })
    );
    rig.answer({ type: 'result', subtype: 'success', is_error: false, session_id: id });
    rig.answer(task('task_notification', 'child', { status: 'completed', summary: 'x' }));
    rig.answer(task('task_notification', 'own', { status: 'completed', summary: 'y' }));
    rig.answer({ type: 'system', subtype: 'init', session_id: id });
    rig.answer(task('task_notification', 'own', { status: 'completed', summary: 'y' }));
    await session.flush();
    const marks = (await lines(id)).filter((line) => 'mark' in line);
    assert.equal(marks.length, 1, 'one trigger: the child end and the repeat write none');
    assert.deepEqual(
      { ...marks[0], at: undefined },
      {
        mark: 'trigger',
        trigger: 'task',
        status: 'completed',
        at: undefined
      }
    );
  });

  it('streams root text under its message and block, and the block’s frame closes it', async () => {
    const id = 'stream-1111-2222-3333-444444444444';
    const rig = stub();
    const session = opened(id, rig);
    rig.answer(started('msg_s'));
    rig.answer(block(0));
    rig.answer(delta(0, 'Hello '));
    rig.answer(delta(0, 'there'));
    assert.deepEqual(drawn(session), { turns: [], tail: [['msg_s:0', 'Hello there']] });

    rig.answer(said('msg_s', 'Hello there'));
    assert.deepEqual(
      drawn(session),
      { turns: [['assistant', 'Hello there', false]], tail: [] },
      'out of the tail and into history in the one frame'
    );
    await session.flush();
    assert.deepEqual(
      (await lines(id)).map((line) => [line.text, line.m]),
      [['Hello there', 'msg_s']]
    );
  });

  it('says each root text delta is the agent at work, while the card state stays put', () => {
    const rig = stub();
    const session = opened('active-1111-2222-3333-444444444444', rig);
    let spoke = 0;
    session.onActivity(() => spoke++);
    rig.answer(started('msg_a'));
    rig.answer(block(0));
    rig.answer(delta(0, 'one'));
    const open = session.state;
    rig.answer(delta(0, ' two'));
    rig.answer(delta(0, ' three'));
    assert.equal(session.state, open, 'no card state moved');
    assert.equal(spoke, 3);
    rig.answer(delta(0, 'theirs', 'toolu_sub'));
    assert.equal(spoke, 3, "a subagent's text is not this session at work");
  });

  it('streams each block of one message as its own row', () => {
    const rig = stub();
    const session = opened('blocks-1111-2222-3333-444444444444', rig);
    rig.answer(started('msg_b'));
    rig.answer(block(0));
    rig.answer(delta(0, 'Looking.'));
    rig.answer(said('msg_b', 'Looking.'));
    rig.answer(block(1));
    rig.answer(delta(1, 'Found it.'));
    assert.deepEqual(drawn(session), {
      turns: [['assistant', 'Looking.', false]],
      tail: [['msg_b:1', 'Found it.']]
    });
    rig.answer(said('msg_b', 'Found it.'));
    assert.deepEqual(drawn(session).turns, [
      ['assistant', 'Looking.', false],
      ['assistant', 'Found it.', false]
    ]);
  });

  it('keeps a subagent’s frames out', () => {
    const rig = stub();
    const session = opened('subagent-1111-2222-3333-444444444444', rig);
    rig.answer(started('msg_sub', 'toolu_task'));
    rig.answer(block(0, 'toolu_task'));
    rig.answer(delta(0, 'inside the task', 'toolu_task'));
    rig.answer({ ...said('msg_sub', 'inside the task'), parent_tool_use_id: 'toolu_task' });
    assert.deepEqual(drawn(session), { turns: [], tail: [] });
  });

  it('keeps an interrupted block whole, cut off, off its aborted frame', async () => {
    // Step 2's sequence (2.1.292): the partial block's `assistant` arrives with
    // `aborted: true` and the text received so far, then the interrupted result.
    const id = 'aborted-1111-2222-3333-444444444444';
    const rig = stub();
    const session = opened(id, rig);
    rig.answer(started('msg_cut'));
    rig.answer(block(0));
    rig.answer(delta(0, 'The lamp on '));
    rig.answer(delta(0, 'Harrow Rock'));
    rig.answer(said('msg_cut', 'The lamp on Harrow Rock', { aborted: true }));
    rig.answer({ type: 'result', subtype: 'error_during_execution' });
    assert.deepEqual(drawn(session), {
      turns: [['assistant', 'The lamp on Harrow Rock', true], ['break']],
      tail: []
    });
    await session.flush();
    assert.deepEqual(
      (await lines(id)).map((line) => [line.text ?? line.mark, line.cut, line.m]),
      [
        ['The lamp on Harrow Rock', true, 'msg_cut'],
        ['break', undefined, undefined]
      ],
      'written once, flagged, under the message it belongs to'
    );
  });

  it('cuts a block still streaming when its turn ends', () => {
    const rig = stub();
    const session = opened('unfinished-1111-2222-3333-444444444444', rig);
    rig.answer(started('msg_half'));
    rig.answer(block(0));
    rig.answer(delta(0, 'half a sentence'));
    rig.answer({ type: 'result', subtype: 'error_during_execution' });
    assert.deepEqual(drawn(session), {
      turns: [['assistant', 'half a sentence', true], ['break']],
      tail: []
    });
  });

  it('cuts a block still streaming when its turn idles without a result', async () => {
    // The `result` can go missing; the CLI's `idle` state frame then ends the
    // turn (`reduce`), and it ends the turn's blocks with it.
    const id = 'idled-1111-2222-3333-444444444444';
    const rig = stub();
    const session = opened(id, rig);
    rig.answer({ type: 'system', subtype: 'session_state_changed', state: 'running' });
    rig.answer(started('msg_idle'));
    rig.answer(block(0));
    rig.answer(delta(0, 'said quietly'));
    rig.answer({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    assert.deepEqual(drawn(session), {
      turns: [['assistant', 'said quietly', true]],
      tail: []
    });
    await session.flush();
    assert.deepEqual(
      (await lines(id)).map((line) => [line.text, line.cut]),
      [['said quietly', true]],
      'and the rows behind it are written'
    );
  });

  it('keeps text the child wrote before it died, until its output closes', async () => {
    // Step 2 (2.1.292): a delta already buffered arrived after SIGKILL, before
    // stdout closed. The exit is not the end of the words; the close is.
    const id = 'killed-1111-2222-3333-444444444444';
    const rig = dying();
    const session = opened(id, rig);
    rig.answer(started('msg_kill'));
    rig.answer(block(0));
    rig.answer(delta(0, 'before the kill'));
    rig.exit();
    rig.answer(delta(0, ' and after'));
    assert.deepEqual(drawn(session).tail, [['msg_kill:0', 'before the kill and after']]);
    rig.drained();
    assert.deepEqual(drawn(session), {
      turns: [['assistant', 'before the kill and after', true]],
      tail: []
    });
    await session.flush();
    assert.deepEqual(
      (await lines(id)).map((line) => [line.text, line.cut]),
      [['before the kill and after', true]]
    );
  });

  it('starts the next conversation on a /clear, and the old one keeps its turns', async () => {
    const before = 'cleared-1111-2222-3333-444444444444';
    const next = 'clearnext-1111-2222-3333-444444444444';
    const rig = stub();
    const session = opened(before, rig);
    rig.answer({ type: 'system', subtype: 'init', session_id: before });
    rig.answer(said('msg_old', 'from before'));
    rig.answer({ type: 'conversation_reset', session_id: before });
    assert.deepEqual(
      [session.thread.snapshot().conversation, drawn(session).turns],
      ['', []],
      'the old conversation ends at the reset; the next is named by its init'
    );
    rig.answer({ type: 'system', subtype: 'init', session_id: next });
    rig.answer(said('msg_new', 'from after'));
    const shot = session.thread.snapshot();
    assert.equal(shot.conversation, next);
    assert.deepEqual(drawn(session).turns, [['assistant', 'from after', false]]);
    await session.flush();
    assert.deepEqual(
      (await lines(before)).map((line) => line.text),
      ['from before']
    );
    assert.deepEqual(
      (await lines(next)).map((line) => line.text),
      ['from after']
    );
  });
});

describe('Claude correlated message facts', () => {
  it('does not complete held messages on the previous result or its trailing idle', async () => {
    const rig = stub();
    const handle = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1 });
    alive.push(handle);
    assert.ok(handle.messages);
    handle.messages.send('same words', [], undefined, false, undefined, 'a');
    await outbox(handle, 0);
    rig.answer(turnStarted('claude-opus-5'));
    handle.messages.send('same words', [], undefined, false, undefined, 'b');
    handle.messages.send('same words', [], undefined, false, undefined, 'c');
    rig.answer({
      type: 'result',
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed'
    });
    await outbox(handle, 0);
    rig.answer({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    assert.deepEqual(handle.state.messageFacts, [
      { correlation: 'a', phase: 'done' },
      { correlation: 'b', phase: 'processing' },
      { correlation: 'c', phase: 'processing' }
    ]);
    rig.answer(turnStarted('claude-opus-5'));
    rig.answer({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'api_error'
    });
    assert.deepEqual(handle.state.messageFacts, [
      { correlation: 'a', phase: 'done' },
      { correlation: 'b', phase: 'unsuccessful' },
      { correlation: 'c', phase: 'unsuccessful' }
    ]);
  });
});
