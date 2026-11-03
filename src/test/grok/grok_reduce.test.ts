import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eventsFrom } from '../../core/grok/reduce';
import { applyEvent, applyEvents, initial } from '../../core/live';

describe('Grok eventsFrom', () => {
  it('reads effort from both live configuration notification shapes', () => {
    assert.deepEqual(
      eventsFrom('_x.ai/session_notification', {
        sessionId: 'g1',
        update: {
          sessionUpdate: 'model_changed',
          model_id: 'grok-4.6',
          reasoning_effort: 'xhigh'
        }
      }),
      [
        {
          kind: 'model',
          model: 'grok-4.6',
          raw: {
            source: 'grok',
            nativeType: '_x.ai/session_notification',
            payload: {
              sessionId: 'g1',
              update: {
                sessionUpdate: 'model_changed',
                model_id: 'grok-4.6',
                reasoning_effort: 'xhigh'
              }
            }
          }
        },
        {
          kind: 'effort',
          effort: 'xhigh',
          raw: {
            source: 'grok',
            nativeType: '_x.ai/session_notification',
            payload: {
              sessionId: 'g1',
              update: {
                sessionUpdate: 'model_changed',
                model_id: 'grok-4.6',
                reasoning_effort: 'xhigh'
              }
            }
          }
        }
      ]
    );
    const [updated] = eventsFrom('session/update', {
      sessionId: 'g1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          { id: 'reasoning_effort', currentValue: 'low', options: [{ value: 'low' }] }
        ]
      }
    });
    assert.equal(updated?.kind, 'effort');
    assert.equal(updated?.kind === 'effort' ? updated.effort : undefined, 'low');
  });

  it('reads the model off model_changed, and the effort when that rides along', () => {
    const both = eventsFrom('_x.ai/session_notification', {
      sessionId: 'g1',
      update: {
        sessionUpdate: 'model_changed',
        model_id: 'grok-4.5',
        reasoning_effort: 'high'
      }
    });
    assert.deepEqual(
      both.map((event) =>
        event.kind === 'model' ? event.model : event.kind === 'effort' ? event.effort : event.kind
      ),
      ['grok-4.5', 'high']
    );
    const modelOnly = eventsFrom('session/update', {
      sessionId: 'g1',
      update: { sessionUpdate: 'model_changed', model_id: 'grok-4.6' }
    });
    assert.deepEqual(
      modelOnly.map((event) => event.kind),
      ['model']
    );
    assert.equal(
      modelOnly[0] && modelOnly[0].kind === 'model' ? modelOnly[0].model : undefined,
      'grok-4.6'
    );
  });
  it('ignores a roster line that is not this session', () => {
    const events = eventsFrom(
      '_x.ai/sessions/changed',
      { sessions: [{ sessionId: 'other', activity: 'idle' }] },
      'g1'
    );
    assert.deepEqual(events, []);
  });

  it('matches a roster row spelled session_id', () => {
    const events = eventsFrom(
      '_x.ai/sessions/changed',
      { sessions: [{ session_id: 'g1', activity: 'working' }] },
      'g1'
    );
    assert.equal(events[0] && events[0].kind === 'status' && events[0].status, 'busy');
  });

  it('maps a roster working line to status busy', () => {
    const events = eventsFrom(
      '_x.ai/sessions/changed',
      { sessions: [{ sessionId: 'g1', activity: 'working' }] },
      'g1'
    );
    assert.deepEqual(
      events.map((e) => e.kind),
      ['status']
    );
    assert.equal(events[0] && events[0].kind === 'status' && events[0].status, 'busy');
  });

  // 2026-08-17 / 1.0.5 probe: 14/14 `_x.ai/sessions/changed` were
  // `{ upserted, removed }`. Zero carried `sessions`. Row key is `modelId`.
  it('reads a 1.0.5 roster upserted row', () => {
    const events = eventsFrom(
      '_x.ai/sessions/changed',
      {
        upserted: [{ sessionId: 'g1', activity: 'working', modelId: 'grok-4.6' }],
        removed: []
      },
      'g1'
    );
    assert.equal(events[0] && events[0].kind === 'status' && events[0].status, 'busy');
    assert.equal(events[1] && events[1].kind === 'model' && events[1].model, 'grok-4.6');
  });

  it('ignores an upserted roster line that is not this session', () => {
    const events = eventsFrom(
      '_x.ai/sessions/changed',
      { upserted: [{ sessionId: 'other', activity: 'idle' }], removed: [] },
      'g1'
    );
    assert.deepEqual(events, []);
  });

  it('drops a load-replay chunk so it does not become a live turn', () => {
    const events = eventsFrom('session/update', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'old turn' },
      _meta: { isReplay: true }
    });
    assert.deepEqual(events, []);
    assert.deepEqual(
      eventsFrom('_x.ai/session/update', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'old turn' },
        _meta: { isReplay: true }
      }),
      []
    );
    assert.deepEqual(
      eventsFrom('session/update', {
        sessionId: 'g1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'old turn' },
          _meta: { isReplay: true }
        }
      }),
      []
    );
  });

  it('maps an agent message chunk to text', () => {
    const events = eventsFrom('session/update', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'pong' }
    });
    assert.equal(events[0]?.kind, 'text');
    assert.equal(events[0] && events[0].kind === 'text' && events[0].text, 'pong');
  });

  it('reads the ACP { sessionId, update } envelope as a live turn', () => {
    const text = eventsFrom('session/update', {
      sessionId: 'g1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'pong' }
      }
    });
    assert.equal(text[0]?.kind, 'text');
    assert.equal(text[0] && text[0].kind === 'text' && text[0].text, 'pong');
    const tool = eventsFrom('session/update', {
      sessionId: 'g1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'search_replace',
        rawInput: { file_path: '/tmp/a.ts' }
      }
    });
    assert.equal(tool[0]?.kind, 'tool-start');
    assert.equal(tool[0] && tool[0].kind === 'tool-start' && tool[0].name, 'search_replace');
  });

  it('treats a monitor wake as a turn: tools busy, turn_completed idle', () => {
    // 2026-08-17 session 01a00dcb: monitor ended, Grok continued with no
    // session/prompt from us. Roster stayed idle; the card followed it.
    let state = initial({ cwd: '/tmp', startedAt: 1 });
    assert.equal(state.status, 'idle');
    state = applyEvents(
      state,
      eventsFrom('session/update', {
        sessionId: 'g1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'reviews are in' }
        }
      })
    );
    assert.equal(state.status, 'busy');
    assert.equal(state.running, true);
    state = applyEvents(
      state,
      eventsFrom('session/update', {
        sessionId: 'g1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Read file'
        }
      })
    );
    assert.equal(state.activeTool, 'Read file');
    state = applyEvents(
      state,
      eventsFrom('_x.ai/session/update', {
        sessionId: 'g1',
        update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }
      })
    );
    assert.equal(state.status, 'idle');
    assert.equal(state.running, false);
    assert.equal(state.activeTool, undefined);
  });

  // 2026-08-18 session 01a015e3: task-completed wake, no session/prompt
  // from us. 1.0.5 probe: 7/7 `turn_completed` rode `_x.ai/session_notification`,
  // zero on `session/update`. Card stayed BUSY because this method was dropped.
  it('idles a self-started turn on session_notification turn_completed', () => {
    let state = initial({ cwd: '/tmp', startedAt: 1 });
    state = applyEvents(
      state,
      eventsFrom('session/update', {
        sessionId: 'g1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'deploy is in' }
        }
      })
    );
    assert.equal(state.status, 'busy');
    state = applyEvents(
      state,
      eventsFrom('_x.ai/session_notification', {
        sessionId: 'g1',
        update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }
      })
    );
    assert.equal(state.status, 'idle');
    assert.equal(state.running, false);
    const flat = eventsFrom('_x.ai/session_notification', {
      sessionUpdate: 'turn_completed',
      stop_reason: 'cancelled'
    });
    assert.equal(flat[0] && flat[0].kind === 'turn-end' && flat[0].outcome, 'interrupted');
  });

  it('clears the running tool when a permission opens, and keeps waiting', () => {
    let state = initial({ cwd: '/tmp', startedAt: 1 });
    state = applyEvents(
      state,
      eventsFrom('session/update', {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Fetch origin'
      })
    );
    assert.equal(state.activeTool, 'Fetch origin');
    state = applyEvent(state, {
      kind: 'waiting',
      requestId: '1',
      open: true,
      ask: false,
      toolName: 'run_terminal_command',
      label: 'Fetch origin'
    });
    assert.equal(state.status, 'waiting');
    assert.equal(state.activeTool, undefined);
    state = applyEvents(
      state,
      eventsFrom(
        '_x.ai/sessions/changed',
        { sessions: [{ sessionId: 'g1', activity: 'working' }] },
        'g1'
      )
    );
    assert.equal(state.status, 'waiting');
    assert.equal(state.activeTool, undefined);
    state = applyEvents(
      state,
      eventsFrom('session/update', {
        sessionUpdate: 'tool_call',
        toolCallId: 'c2',
        title: 'still blocked'
      })
    );
    assert.equal(state.activeTool, undefined);
  });

  it('does not invent permissionMode from roster yolo', () => {
    const state = applyEvents(
      initial({ cwd: '/tmp', startedAt: 1 }),
      eventsFrom(
        '_x.ai/sessions/changed',
        { sessions: [{ sessionId: 'g1', activity: 'working', yolo: true }] },
        'g1'
      )
    );
    assert.equal(state.permissionMode, undefined);
  });

  it('clears the active tool at completion and stays mid-turn', () => {
    let state = initial({ cwd: '/tmp', startedAt: 1 });
    const update = (u: Record<string, unknown>) =>
      applyEvents(state, eventsFrom('session/update', { sessionId: 'g1', update: u }));

    state = update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'first paragraph' }
    });
    state = update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read file' });
    state = update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
    assert.equal(state.running, true);
    assert.equal(state.status, 'busy');
    assert.equal(state.activeTool, undefined);

    state = update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'second paragraph' }
    });
    assert.equal(state.status, 'busy');
  });

  it('clears the active tool when a tool fails', () => {
    let state = initial({ cwd: '/tmp', startedAt: 1 });
    const update = (u: Record<string, unknown>) =>
      applyEvents(state, eventsFrom('session/update', { sessionId: 'g1', update: u }));

    state = update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'about to run it' }
    });
    state = update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash' });
    state = update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' });
    assert.equal(state.running, true);
    assert.equal(state.activeTool, undefined);
  });

  it('stays busy while a tool reports progress', () => {
    let state = initial({ cwd: '/tmp', startedAt: 1 });
    const update = (u: Record<string, unknown>) =>
      applyEvents(state, eventsFrom('session/update', { sessionId: 'g1', update: u }));

    state = update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'streaming still' }
    });
    state = update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'in_progress',
      content: { type: 'text', text: 'partial output' }
    });
    assert.equal(state.status, 'busy');
  });

  it('reduces working + text + idle into a finished turn', () => {
    let state = initial({ cwd: '/tmp', startedAt: 1 });
    state = applyEvents(
      state,
      eventsFrom(
        '_x.ai/sessions/changed',
        { sessions: [{ sessionId: 'g1', activity: 'working' }] },
        'g1'
      )
    );
    assert.equal(state.status, 'busy');
    state = applyEvents(
      state,
      eventsFrom('session/update', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'pong' }
      })
    );
    state = applyEvents(
      state,
      eventsFrom(
        '_x.ai/sessions/changed',
        { sessions: [{ sessionId: 'g1', activity: 'idle' }] },
        'g1'
      )
    );
    assert.equal(state.status, 'idle');
    assert.equal(state.running, false);
    // The roster's idle routes through the shared `endTurn`, so it clears the
    // same fields `turn_completed` does rather than its own copy of them.
    assert.equal(state.activeTool, undefined);
  });

  // Step 0 (1.0.5, 2026-08-25): a self-started turn is announced here and
  // nowhere else — the roster emits no frame for one, and `prompt_complete`
  // never fires. `runningPromptId` is the only place the wire says *which*
  // turn is running, and `turn_completed.prompt_id` echoes it exactly.
  it('carries the running prompt id off a queue frame', () => {
    const events = eventsFrom('_x.ai/queue/changed', {
      sessionId: 'g1',
      entries: [],
      runningPromptId: 'ours-1'
    });
    assert.deepEqual(
      events.map((e) => e.kind),
      ['queue']
    );
    assert.equal(events[0] && events[0].kind === 'queue' && events[0].runningId, 'ours-1');
  });

  it('leaves the running id undefined when the queue names none', () => {
    const events = eventsFrom('_x.ai/queue/changed', { sessionId: 'g1', entries: [] });
    assert.equal(events[0] && events[0].kind === 'queue' && events[0].runningId, undefined);
    assert.equal(events[0] && events[0].kind === 'queue' && events[0].depth, 0);
  });

  // The wake's synthetic id. Read as *an id we did not send* — never by its
  // `task-completed-` prefix, which is one wake kind's spelling and not a
  // contract (Step 0 probed a second kind behind the same field).
  it('reads a foreign running id the same way as ours', () => {
    const events = eventsFrom('_x.ai/queue/changed', {
      sessionId: 'g1',
      entries: [{ id: 'ours-2' }],
      runningPromptId: 'task-completed-01a0387b-982a'
    });
    assert.equal(
      events[0] && events[0].kind === 'queue' && events[0].runningId,
      'task-completed-01a0387b-982a'
    );
    assert.equal(events[0] && events[0].kind === 'queue' && events[0].depth, 1);
  });

  // Scoped like the roster branch, and for a sharper reason: this frame now
  // decides whether a card's drain may write, so another session's queue
  // naming a turn we never sent would say so about the wrong card.
  it('ignores a queue frame belonging to another session', () => {
    assert.deepEqual(
      eventsFrom(
        '_x.ai/queue/changed',
        { sessionId: 'other', entries: [], runningPromptId: 'x' },
        'g1'
      ),
      []
    );
    const mine = eventsFrom(
      '_x.ai/queue/changed',
      { sessionId: 'g1', entries: [], runningPromptId: 'x' },
      'g1'
    );
    assert.equal(mine[0] && mine[0].kind === 'queue' && mine[0].runningId, 'x');
  });

  // `turn_completed.prompt_id` echoes what the queue announced, on both kinds
  // of turn. Carrying it is what lets a close be matched to the turn it
  // belongs to rather than ending whichever turn happens to be running.
  it('carries the ending turn id off turn_completed', () => {
    const [end] = eventsFrom('_x.ai/session_notification', {
      sessionId: 'g1',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'task-completed-abc',
        stop_reason: 'end_turn'
      }
    });
    assert.equal(end && end.kind === 'turn-end' && end.turnId, 'task-completed-abc');
    assert.equal(end && end.kind === 'turn-end' && end.outcome, 'done');
    const [unnamed] = eventsFrom('_x.ai/session_notification', {
      sessionId: 'g1',
      update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }
    });
    assert.equal(unnamed && unnamed.kind === 'turn-end' && unnamed.turnId, undefined);
  });

  it("reads the turn's cached input off turn_completed, and only a stated count", () => {
    const completed = (usage?: unknown) =>
      eventsFrom('_x.ai/session_notification', {
        sessionId: 'g1',
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'p1',
          stop_reason: 'end_turn',
          ...(usage === undefined ? {} : { usage })
        }
      });
    const [read, end] = completed({ cachedReadTokens: 32384, inputTokens: 32763 });
    assert.equal(read && read.kind === 'cache-read' && read.tokens, 32384);
    assert.equal(end?.kind, 'turn-end');
    for (const usage of [undefined, {}, { cachedReadTokens: -1 }, { cachedReadTokens: '9' }]) {
      assert.deepEqual(
        completed(usage).map((event) => event.kind),
        ['turn-end'],
        JSON.stringify(usage)
      );
    }
  });

  // Whichever id it names. The card's word is `turn_completed`'s and the
  // prompt result's; a queue frame is bookkeeping, and one that moved the
  // pill would idle a card mid-turn every time the outbox emptied.
  it('does not move card status on its own, ours or foreign', () => {
    for (const runningPromptId of ['ours-1', 'task-completed-abc', undefined]) {
      const before = applyEvent(initial({ cwd: '/tmp', startedAt: 0 }), {
        kind: 'status',
        status: 'busy'
      });
      const after = applyEvents(
        before,
        eventsFrom('_x.ai/queue/changed', { sessionId: 'g1', entries: [], runningPromptId })
      );
      assert.equal(after.status, 'busy');
      assert.equal(after.running, before.running);
    }
  });
});
