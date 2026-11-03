import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import * as path from 'node:path';

import { after, describe, it } from 'node:test';

let eventsFrom: (typeof import('../../core/codex/reduce'))['eventsFrom'];

let applyEvents: (typeof import('../../core/live'))['applyEvents'];

let initial: (typeof import('../../core/live'))['initial'];

let toSession: (typeof import('../../core/live'))['toSession'];

import { before } from 'node:test';

import { dispose, FIXTURES, setup } from './codex_session_helpers';

before(async () => {
  await setup();
  ({ eventsFrom } = await import('../../core/codex/reduce'));
  ({ applyEvents } = await import('../../core/live'));
  ({ initial } = await import('../../core/live'));
  ({ toSession } = await import('../../core/live'));
});

after(dispose);

describe('recorded Codex lifecycle notifications', () => {
  it('crosses busy to idle and applies settings and usage from the C0 fixtures', async () => {
    const text = JSON.parse(await fs.readFile(path.join(FIXTURES, 'text.json'), 'utf8')) as {
      messages: unknown[];
    };
    const settings = JSON.parse(
      await fs.readFile(path.join(FIXTURES, 'settings.json'), 'utf8')
    ) as { messages: unknown[] };
    let state = initial({ cwd: '<cwd>', startedAt: 1, sessionId: '<thread-1>' });
    let sawBusy = false;
    for (const raw of [...text.messages, ...settings.messages]) {
      const message = raw as { method?: string; params?: unknown };
      if (!message.method) continue;
      state = applyEvents(state, eventsFrom(message.method, message.params, '<thread-1>'));
      sawBusy ||= state.status === 'busy';
    }
    assert.equal(sawBusy, true);
    assert.equal(state.status, 'idle');
    assert.equal(state.running, false);
    assert.equal(state.title, 'AgentsView C0 probe');
    assert.equal(state.model, 'gpt-5.6-sol');
    assert.equal(state.effort, 'low');
    assert.equal(state.permissionMode, 'on-request+workspaceWrite');
    assert.equal(state.contextTokens, 15695);
    assert.equal(state.windowStated, 258_400);
    assert.equal(state.contextPct, 6);
  });

  it('reads a multi-turn thread as the turn in the window, not the thread total', async () => {
    const file = JSON.parse(await fs.readFile(path.join(FIXTURES, 'file.json'), 'utf8')) as {
      messages: unknown[];
    };
    let state = initial({ cwd: '<cwd>', startedAt: 1, sessionId: '<thread-1>' });
    for (const raw of file.messages) {
      const message = raw as { method?: string; params?: unknown };
      if (!message.method) continue;
      state = applyEvents(state, eventsFrom(message.method, message.params, '<thread-1>'));
    }
    // The fixture's final usage states 153,780 accumulated across the thread
    // beside 18,677 for the turn that actually occupies the window. Reading the
    // first drew the card at 60% of 258,400 with 7% in the model's hands, and
    // the gap only widens with every turn a thread survives.
    assert.equal(state.contextTokens, 18_677);
    assert.equal(state.windowStated, 258_400);
    assert.equal(state.contextPct, 7);
  });

  it('uses the reported runtime budget for the window and occupancy', () => {
    const reported = (stated: number) =>
      applyEvents(
        initial({ cwd: '<cwd>', startedAt: 1, sessionId: '<thread-1>' }),
        eventsFrom(
          'thread/tokenUsage/updated',
          {
            threadId: '<thread-1>',
            tokenUsage: { last: { totalTokens: 27_200 }, modelContextWindow: stated }
          },
          '<thread-1>'
        )
      );
    for (const stated of [258_400, 475_000, 121_600, 258_401, 872_000]) {
      assert.equal(reported(stated).windowStated, stated);
    }
    assert.equal(reported(258_400).contextPct, 11);
    assert.equal(reported(475_000).contextPct, 6);
  });

  it('says nothing about the share when the thread stated no window', () => {
    const state = applyEvents(
      initial({ cwd: '<cwd>', startedAt: 1, sessionId: '<thread-1>' }),
      eventsFrom(
        'thread/tokenUsage/updated',
        { threadId: '<thread-1>', tokenUsage: { last: { totalTokens: 900 } } },
        '<thread-1>'
      )
    );
    assert.equal(state.contextTokens, 900);
    assert.equal(state.contextPct, undefined, 'a guessed window is a wrong percentage');
  });

  it('divides into no window the launch merely asked for', () => {
    // `squadron.contextWindow` reaches every brand, so a Codex thread can
    // hold a `windowAsked` nothing on the wire ever confirmed. Answering its
    // occupancy with that figure would put a percentage on the card in Codex's
    // name that Codex never stated.
    const state = applyEvents(
      initial({ cwd: '<cwd>', startedAt: 1, sessionId: '<thread-1>', window: 200_000 }),
      eventsFrom(
        'thread/tokenUsage/updated',
        { threadId: '<thread-1>', tokenUsage: { last: { totalTokens: 900 } } },
        '<thread-1>'
      )
    );
    assert.equal(state.windowAsked, 200_000);
    assert.equal(state.contextTokens, 900);
    assert.equal(state.contextPct, undefined);
  });

  it('reads a stated window of zero as no window at all', () => {
    // `finite` admits zero and a share of zero is 100% or `NaN`. The seam
    // narrows to positive, which is what `catalog.ts` has always meant by a
    // window being named.
    const state = applyEvents(
      initial({ cwd: '<cwd>', startedAt: 1, sessionId: '<thread-1>' }),
      eventsFrom(
        'thread/tokenUsage/updated',
        {
          threadId: '<thread-1>',
          tokenUsage: { last: { totalTokens: 900 }, modelContextWindow: 0 }
        },
        '<thread-1>'
      )
    );
    assert.equal(state.windowStated, undefined);
    assert.equal(state.contextPct, undefined);
  });

  it('reads cached input per request, keeps a zero, and invents none', () => {
    const read = (tokenUsage: Record<string, unknown>) =>
      eventsFrom(
        'thread/tokenUsage/updated',
        { threadId: '<thread-1>', tokenUsage },
        '<thread-1>'
      ).filter((event) => event.kind === 'cache-read');
    assert.deepEqual(
      read({
        last: { totalTokens: 30_319, cachedInputTokens: 29_440 },
        total: { totalTokens: 180_000, cachedInputTokens: 150_000 }
      }),
      [{ kind: 'cache-read', tokens: 29_440 }]
    );
    assert.deepEqual(read({ last: { totalTokens: 900, cachedInputTokens: 0 } }), [
      { kind: 'cache-read', tokens: 0 }
    ]);
    assert.deepEqual(read({ last: { totalTokens: 900 }, total: { cachedInputTokens: 5 } }), []);
  });

  it('ignores malformed, unknown, and cross-thread notifications', () => {
    assert.deepEqual(eventsFrom('thread/status/changed', null, '<thread-1>'), []);
    assert.deepEqual(
      eventsFrom(
        'thread/status/changed',
        { threadId: '<thread-2>', status: { type: 'active', activeFlags: [] } },
        '<thread-1>'
      ),
      []
    );
    assert.deepEqual(eventsFrom('item/agentMessage/delta', { threadId: '<thread-1>' }), []);
  });

  it('maps streaming prose, reasoning, and completed tools without doubling prose', () => {
    assert.deepEqual(
      eventsFrom(
        'item/agentMessage/delta',
        { threadId: '<thread-1>', turnId: '<turn-1>', itemId: '<message-1>', delta: 'hi' },
        '<thread-1>'
      ),
      [{ kind: 'text', text: 'hi', id: '<message-1>' }]
    );
    assert.deepEqual(
      eventsFrom(
        'item/reasoning/summaryTextDelta',
        { threadId: '<thread-1>', itemId: '<reasoning>', delta: 'checking' },
        '<thread-1>'
      ),
      [{ kind: 'thought', text: 'checking' }]
    );
    assert.deepEqual(
      eventsFrom(
        'item/completed',
        {
          threadId: '<thread-1>',
          item: { type: 'agentMessage', id: '<message-1>', text: 'hi' }
        },
        '<thread-1>'
      ),
      [],
      'the completed replacement is for the record, not a second live delta'
    );
    assert.deepEqual(
      eventsFrom(
        'item/started',
        {
          threadId: '<thread-1>',
          item: { type: 'commandExecution', id: '<cmd>', command: 'pwd', cwd: '<cwd>' }
        },
        '<thread-1>'
      ),
      [{ kind: 'tool-start', id: '<cmd>', name: 'Bash', input: { command: 'pwd', cwd: '<cwd>' } }]
    );
  });

  it('maps a system error to unknown and ends any running turn', () => {
    const busy = applyEvents(initial({ cwd: '<cwd>', startedAt: 1 }), [
      { kind: 'status', status: 'busy' }
    ]);
    const state = applyEvents(
      busy,
      eventsFrom(
        'thread/status/changed',
        { threadId: '<thread-1>', status: { type: 'systemError' } },
        '<thread-1>'
      )
    );
    assert.equal(state.status, 'unknown');
    assert.equal(state.running, false);
    // Which of the two app-server words it was. Both land on the same card and
    // they mean very different things, so the card alone cannot be read back.
    assert.equal(state.unknownFrom, 'status:systemError');
  });

  it('carries the wire’s word for a thread that is not loaded', () => {
    const [event] = eventsFrom(
      'thread/status/changed',
      { threadId: '<thread-1>', status: { type: 'notLoaded' } },
      '<thread-1>'
    );
    assert.deepEqual(event, { kind: 'status', status: 'unknown', native: 'notLoaded' });
  });

  it('ends the invalid-effort capture idle, with the failure the completion states', () => {
    // `cli_state/codex/protocol.md`, reasoning effort, 0.153.2: systemError,
    // then the error notification, then turn/completed failed. systemError
    // already ended the turn; the completion is what says how.
    const held = { pid: 1, startedAt: 1, updatedAt: 1, brand: 'codex' as const };
    const thread = '<thread-1>';
    let state = applyEvents(initial({ cwd: '<cwd>', startedAt: 1 }), [
      { kind: 'status', status: 'busy' }
    ]);
    state = applyEvents(
      state,
      eventsFrom(
        'thread/status/changed',
        { threadId: thread, status: { type: 'systemError' } },
        thread
      )
    );
    assert.equal(state.status, 'unknown');
    assert.equal(state.running, false);
    assert.ok(!('turnOutcome' in toSession(state, held, 'w')));
    state = applyEvents(
      state,
      eventsFrom(
        'error',
        {
          threadId: thread,
          message:
            "[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'banana'"
        },
        thread
      )
    );
    assert.equal(state.status, 'unknown');
    state = applyEvents(
      state,
      eventsFrom(
        'turn/completed',
        {
          threadId: thread,
          turn: { id: '<turn-1>', status: 'failed', error: { message: 'invalid effort' } }
        },
        thread
      )
    );
    const card = toSession(state, held, 'w');
    assert.equal(card.status, 'idle');
    assert.equal(card.turnOutcome, 'error');
    assert.equal(state.running, false);
  });

  it('names the three completion statuses and leaves any other one unstated', () => {
    const held = { pid: 1, startedAt: 1, updatedAt: 1, brand: 'codex' as const };
    const thread = '<thread-1>';
    const busy = applyEvents(initial({ cwd: '<cwd>', startedAt: 1 }), [
      { kind: 'status', status: 'busy' }
    ]);
    const ended = (turn: Record<string, unknown>) =>
      toSession(
        applyEvents(busy, eventsFrom('turn/completed', { threadId: thread, turn }, thread)),
        held,
        'w'
      );
    assert.equal(ended({ id: '<turn-1>', status: 'completed' }).turnOutcome, 'done');
    assert.equal(ended({ id: '<turn-1>', status: 'interrupted' }).turnOutcome, 'interrupted');
    assert.equal(ended({ id: '<turn-1>', status: 'failed' }).turnOutcome, 'error');
    for (const turn of [
      { id: '<turn-1>' },
      { id: '<turn-1>', status: null },
      { id: '<turn-1>', status: 'banana' }
    ]) {
      const card = ended(turn);
      assert.equal(card.status, 'idle', JSON.stringify(turn));
      assert.ok(!('turnOutcome' in card), JSON.stringify(turn));
    }
    assert.deepEqual(
      eventsFrom(
        'turn/completed',
        { threadId: '<other>', turn: { id: 't', status: 'failed' } },
        thread
      ),
      [],
      'a cross-thread completion is not this thread’s close'
    );
    assert.equal(busy.status, 'busy');
  });
});
