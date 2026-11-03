import * as assert from 'node:assert/strict';

import { before, describe, it } from 'node:test';

import {
  INIT,
  RESULT,
  askRequest,
  delta,
  frame,
  live,
  messageStart,
  reduce,
  run,
  setup,
  writeRequest
} from '../session/live_helpers';

before(setup);

describe('reduce', () => {
  it('takes the session, model, mode and cwd off init', () => {
    const state = run([INIT]);
    assert.equal(state.sessionId, 'sess-1');
    assert.equal(state.model, 'claude-opus-5');
    assert.equal(state.permissionMode, 'acceptEdits');
    assert.equal(state.cwd, '/repo/app');
    assert.match(state.transcript ?? '', /projects[\\/]-repo-app[\\/]sess-1\.jsonl$/);
    assert.equal(state.status, 'busy', 'init only ever arrives inside a turn');
  });

  it('keeps the transcript where it was filed when the session walks off', () => {
    // `init` restates the cwd every turn and states the new one once the
    // session has `cd`-ed; the transcript does not move with it.
    const moved = { ...INIT, cwd: '/repo/app/docs' };
    const state = run([INIT, RESULT, moved]);
    assert.equal(state.cwd, '/repo/app/docs');
    assert.match(state.transcript ?? '', /projects[\\/]-repo-app[\\/]sess-1\.jsonl$/);
  });

  // The card's group is where the *conversation began*, not where the session
  // stands now, and that is what tells a monorepo package (started in
  // `packages/api`) from a directory a session merely walked into. It used to be
  // recovered by finding the transcript on disk and reading its head — four
  // fixes were paid for that lookup. The first `init` states it for free.
  it('pins the origin cwd at the first init and holds it through a move', () => {
    const moved = { ...INIT, cwd: '/repo/app/docs/mockups' };
    const state = run([INIT, RESULT, moved]);
    assert.equal(state.cwd, '/repo/app/docs/mockups', 'the live reading still moves');
    assert.equal(state.originCwd, '/repo/app', 'the origin does not');
  });

  // An `EnterWorktree` is the same rule and the opposite filesystem behaviour:
  // the CLI *moves* the transcript there, so a lookup would answer the worktree
  // while the work still belongs to the repository it was cut from.
  it('holds the origin through an EnterWorktree', () => {
    const entered = { ...INIT, cwd: '/repo/app/.worktrees/wt' };
    const state = run([INIT, RESULT, entered]);
    assert.equal(state.originCwd, '/repo/app');
  });

  // A `/clear` is a new conversation, and it begins where the session is
  // standing — the same rule the transcript path already follows.
  it('re-pins the origin when a clear mints a new conversation', () => {
    const cleared = { ...INIT, cwd: '/repo/app/docs', session_id: 'sess-2' };
    const state = run([INIT, RESULT, cleared]);
    assert.equal(state.originCwd, '/repo/app/docs');
  });

  // The group and the chip answer different questions, and a move separates
  // them: the work still belongs to the repository the conversation began in,
  // but the branch is whatever the session is standing on now.
  it('carries the live directory beside the origin once they diverge', () => {
    const entered = { ...INIT, cwd: '/repo/app/.worktrees/wt' };
    const state = run([INIT, RESULT, entered]);
    const card = live.toSession(
      state,
      { pid: 7, startedAt: 1000, updatedAt: 1000, brand: 'claude' },
      'w'
    );
    assert.equal(card.cwd, '/repo/app', 'the group is the origin');
    assert.equal(card.liveCwd, '/repo/app/.worktrees/wt', 'the chip reads from here');
  });

  it('states no live directory for a session that never moved', () => {
    const card = live.toSession(
      run([INIT]),
      { pid: 7, startedAt: 1000, updatedAt: 1000, brand: 'claude' },
      'w'
    );
    assert.equal(card.cwd, '/repo/app');
    assert.equal(card.liveCwd, undefined);
  });

  // `startOwned` always passes a sessionId, so both arms of the old re-pin
  // (`sessionId !== state.sessionId || !state.originCwd`) were false at the
  // first `init` when origin was seeded from the spawn cwd. A macOS tmpdir
  // spawn (`/var/folders`) and the CLI's first `init` (`/private/var/folders`)
  // then looked like a move for the life of the session.
  it('takes the first init cwd when the spawn already named the session', () => {
    const from = live.initial({
      cwd: '/var/folders/xx/T',
      startedAt: 1000,
      sessionId: 'sess-1'
    });
    const state = run([{ ...INIT, cwd: '/private/var/folders/xx/T' }], from);
    assert.equal(state.originCwd, '/private/var/folders/xx/T');
    const card = live.toSession(
      state,
      { pid: 7, startedAt: 1000, updatedAt: 1000, brand: 'claude' },
      'w'
    );
    assert.equal(card.cwd, '/private/var/folders/xx/T');
    assert.equal(card.liveCwd, undefined);
  });

  it('files a cleared session where it now stands', () => {
    const cleared = { ...INIT, cwd: '/repo/app/docs', session_id: 'sess-2' };
    const state = run([INIT, RESULT, cleared]);
    assert.match(state.transcript ?? '', /projects[\\/]-repo-app-docs[\\/]sess-2\.jsonl$/);
  });

  it('leaves a mode the next init does not restate', () => {
    const state = run([INIT, RESULT, { type: 'system', subtype: 'init', session_id: 'sess-1' }]);
    assert.equal(state.permissionMode, 'acceptEdits');
    assert.equal(state.model, 'claude-opus-5');
  });

  it('does not read a hook frame as the start of a turn', () => {
    // Hooks fire before a session has done anything — a probe that never sent a
    // turn saw `SessionStart` frames and nothing else for 180s. A card that went
    // busy on one would be busy from the moment it was spawned.
    const state = run([
      { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' },
      { type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup' }
    ]);
    assert.equal(state.status, 'idle');
  });

  it('does not latch busy on a system subtype it has no rule for', () => {
    // The regression. There are ~30 system subtypes and half can arrive outside
    // a turn; `running` clears on two frames only, so one stray frame after a
    // turn ended pinned a card on BUSY for the life of the process — five of
    // them at once, one for 35 minutes, observed 2026-07-28. `init` opens a
    // turn; everything else is silence.
    const done = run([INIT, RESULT]);
    const state = run([{ type: 'system', subtype: 'api_retry', session_id: 'sess-1' }], done);
    assert.equal(state.status, 'idle', 'a retry is not the start of a turn');
    assert.equal(state, done, 'and a frame that changes nothing returns the same state');
  });

  it('does not read a replayed echo as the start of a turn', () => {
    // The same failure shape as the two above, from a different door. A
    // `set_model` is answered with a `user` frame carrying `isReplay: true` —
    // `<local-command-stdout>Set model to haiku (…)</local-command-stdout>` —
    // and it arrives with the session idle, with no `result` behind it. Read as
    // a turn frame, it pinned the card on BUSY until some later turn ended, so
    // switching a model on an idle card made it lie about what it was doing.
    // Observed 2026-08-06 on 2.1.220 (`docs/reference/cli_state/claude/protocol.md`).
    const done = run([INIT, RESULT]);
    const state = run([{ type: 'user', isReplay: true }], done);
    assert.equal(state.status, 'idle', 'an echo is not the start of a turn');
    assert.equal(state, done, 'and a frame that changes nothing returns the same state');
  });

  it('still reads an ordinary tool result as a turn frame', () => {
    // The guard above must key on the flag and not on the frame type: a `user`
    // frame is how a tool result arrives, and that one really is a turn.
    const state = run([INIT, { type: 'user' }]);
    assert.equal(state.status, 'busy');
  });

  it('does not change the card state for further text in an open turn', () => {
    const busy = run([INIT]);
    assert.equal(run([delta('words')], busy), busy);
    assert.equal(live.applyEvent(busy, { kind: 'text', text: 'words' }), busy);
    const idle = live.initial({ cwd: '/tmp', startedAt: 1 });
    assert.equal(live.applyEvent(idle, { kind: 'text', text: 'words' }).status, 'busy');
  });

  it('stays busy through text and idles on the result', () => {
    const mid = run([INIT, delta('Hel'), delta('lo there')]);
    assert.equal(mid.status, 'busy');

    const done = run([RESULT], mid);
    assert.equal(done.status, 'idle');
  });

  it('reads a question after prose as waiting', () => {
    // The one message whose completion does *not* hand the words to the
    // transcript: a turn is appended once its tools finish, and an
    // `AskUserQuestion` finishes when it is answered. The frames, timed against
    // 2.1.220, are in `docs/reference/cli_state/claude/protocol.md` under "Assistant text arrives live".
    // Clearing on the `assistant` frame left the dock showing a question with no
    // framing, which is the whole of what the model said about it.
    const state = run([INIT, delta('Need input.'), { type: 'assistant' }, askRequest]);
    assert.equal(state.status, 'waiting');
  });

  it('names the tool a turn opened, until the turn ends', () => {
    const busy = run([
      INIT,
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } },
        parent_tool_use_id: null
      }
    ]);
    assert.equal(busy.activeTool, 'Bash');
    assert.equal(run([RESULT], busy).activeTool, undefined);
  });

  it('reads a subagent’s stream as a running turn', () => {
    const state = run([
      INIT,
      delta('mine'),
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'theirs' } },
        parent_tool_use_id: 'toolu_task'
      }
    ]);
    assert.equal(state.status, 'busy', 'a subagent’s frame is still this turn running');
  });

  it('reads context as the newest message’s share of its window', () => {
    // The CLI's own arithmetic over the CLI's own numerator: input plus both
    // cache counts, against the window that model answers in.
    const state = run([INIT, messageStart]);
    assert.equal(state.contextTokens, 28_317);
    assert.equal(state.contextPct, 3);
  });

  it('says nothing about context for a model nobody has a window for', () => {
    const start = {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { model: 'claude-unheard-of', usage: { input_tokens: 1000 } }
      },
      parent_tool_use_id: null
    };
    const unknown = run([start]);
    assert.equal(unknown.contextTokens, 1000);
    assert.equal(unknown.contextPct, undefined, 'a guessed window is a wrong percentage');

    // Until a result states one — which an owned session is the only thing on
    // this machine to do, since it writes no statusline dump.
    const taught = run([
      { ...RESULT, modelUsage: { 'claude-unheard-of': { contextWindow: 200_000 } } },
      start
    ]);
    assert.equal(taught.contextPct, 1);
  });

  it('drops the context reading when a `/clear` mints a new conversation', () => {
    const held = run([INIT, messageStart]);
    assert.equal(held.contextPct, 3, 'the reading it had before the clear');

    const cleared = run([{ ...INIT, session_id: 'sess-2' }], held);
    assert.equal(cleared.sessionId, 'sess-2');
    assert.equal(cleared.contextPct, undefined);
    assert.equal(cleared.contextTokens, undefined, 'zero would be a guess of its own');

    // And the same `init` restated for the same conversation changes nothing:
    // this is a turn's frame, not a clear.
    assert.equal(run([INIT], held).contextPct, 3);
  });

  it('drops it again when a compaction rewrites what the model holds', () => {
    // The boundary arrives once the compaction has returned — the reading it
    // invalidates is the last pre-compaction `message_start`'s. `result` closes
    // the same turn and must not divide the old count back into a percentage.
    const held = run([INIT, messageStart]);
    assert.equal(held.contextPct, 3, 'else the drop below is asserted against nothing');

    const state = run(
      [{ type: 'system', subtype: 'compact_boundary', session_id: 'sess-1' }, RESULT],
      held
    );
    assert.equal(state.contextPct, undefined);
    assert.equal(state.contextTokens, undefined);
  });

  it('holds an ask as a pending request, with its questions parsed', () => {
    const state = run([INIT, askRequest]);
    assert.equal(state.status, 'waiting');
    assert.equal(state.pending.length, 1);
    const [request] = state.pending;
    assert.equal(request?.requestId, 'req-1');
    assert.equal(request?.ask, true);
    assert.equal(request?.questions?.length, 2);
    assert.equal(request?.questions?.[1]?.multiSelect, true);
  });

  it('holds a permission prompt as the other kind, with the CLI’s own label', () => {
    // Which kind it is comes from `requires_user_interaction`, never from the
    // tool's name: a renderer keyed on `AskUserQuestion` would call anything
    // else a permission prompt by accident rather than by reading.
    const state = run([INIT, writeRequest]);
    const [request] = state.pending;
    assert.equal(request?.ask, false);
    assert.equal(request?.toolName, 'Write');
    assert.equal(request?.label, 'notes.txt');
    assert.equal(request?.questions, undefined);
    assert.deepEqual(request?.input, { file_path: '/tmp/notes.txt', content: 'hi' });
    assert.equal(request?.suggestions?.[0]?.kind, 'setMode');
    assert.equal(request?.suggestions?.[0]?.where, 'this session only');
  });

  it('names where each suggestion persists, and leaves the ones it cannot name unnamed', () => {
    // The panel offers always-allow only when every suggestion is named, so an
    // unnamed one is how this decoder withholds it. `cliArg` is a flag passed at
    // spawn, which no button can go back and change.
    const where = (destination?: string): string | undefined => {
      const suggestion =
        destination === undefined ? { type: 'addRules' } : { type: 'addRules', destination };
      const request = { ...writeRequest.request, permission_suggestions: [suggestion] };
      const [pending] = run([INIT, { ...writeRequest, request }]).pending;
      return pending?.suggestions?.[0]?.where;
    };
    assert.equal(where('session'), 'this session only');
    assert.match(where('localSettings') ?? '', /settings\.local\.json/);
    assert.match(where('projectSettings') ?? '', /shared/);
    assert.match(where('userSettings') ?? '', /this machine/);
    assert.equal(where('cliArg'), undefined);
    assert.equal(where('someFutureScope'), undefined);
    assert.equal(where(undefined), undefined);
  });

  it('holds both at once, oldest first', () => {
    // `pending_permission_requests` is a list on the wire, so one open request
    // is an assumption rather than a guarantee — a view that renders only the
    // first would leave a session blocked on one nobody can see.
    const state = run([INIT, askRequest, writeRequest]);
    assert.deepEqual(
      state.pending.map((p) => p.requestId),
      ['req-1', 'req-2']
    );
  });

  it('ignores a request id it is already holding', () => {
    const once = run([INIT, askRequest]);
    assert.equal(reduce.reduce(once, frame(askRequest)), once, 'no second card for one request');
  });

  it('drops a request the CLI cancels, and goes back to the running turn', () => {
    // Reachable, and the trigger is an interrupt: the cancel arrives about a
    // millisecond after it, and before the interrupt's own response.
    const waiting = run([INIT, writeRequest]);
    assert.equal(waiting.status, 'waiting');
    const cancelled = run([{ type: 'control_cancel_request', request_id: 'req-2' }], waiting);
    assert.deepEqual(cancelled.pending, []);
    assert.equal(cancelled.status, 'busy', 'the turn is still running until its result');
  });

  it('takes only the reset time off a rate limit event', () => {
    // No percentage and no weekly window on this frame — whatever a card shows
    // as a figure comes from a `get_usage` round trip instead.
    const state = run([
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', resetsAt: 1785151200, rateLimitType: 'five_hour' }
      }
    ]);
    assert.equal(state.limitResetsAt, 1785151200);
    assert.equal(state.usage, undefined);
    assert.equal(state.status, 'idle', 'it says nothing about a turn');
  });

  it('hands back the same state when a frame changes nothing', () => {
    // Identity is what lets a listener skip a repaint, and a turn is a hundred
    // delta frames.
    const state = run([INIT, RESULT]);
    const same = reduce.reduce(
      state,
      frame({ type: 'control_response', response: { subtype: 'success', request_id: 'x' } })
    );
    assert.equal(same, state);
  });
});

describe('session_state_changed', () => {
  // The CLI's own statement of what the session is doing, emitted only for a
  // child started with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`. Observed order
  // is `running` → `init` → … → `result` → `idle`, so it brackets a turn from
  // outside and is a second, independent witness that one has ended.
  const stateEvent = (state: string) => ({
    type: 'system',
    subtype: 'session_state_changed',
    session_id: 'sess-1',
    state
  });

  it('ends a turn the CLI never wrote a result for', () => {
    const busy = run([INIT, delta('half a sentence')]);
    assert.equal(busy.status, 'busy');

    const done = run([stateEvent('idle')], busy);
    assert.equal(done.status, 'idle');
    assert.equal(done.running, false);
  });

  it('opens a turn on `running`, for the compaction `init` arrives too late for', () => {
    // The reason this is not the duplicate of `init` it looks like. `/compact`
    // sends `running` at once and `init` only when the summarising call has
    // returned — 5s on a 27k probe, 143s on a real 315k session, nothing on the
    // pipe or the transcript in between (2026-08-18, 2.1.233). A card that
    // waits for `init` reads idle for all of it, then busy for the 2 ms before
    // `result`.
    const idle = run([INIT, RESULT]);
    assert.equal(idle.status, 'idle');

    const compacting = run([stateEvent('running')], idle);
    assert.equal(compacting.status, 'busy');
    assert.equal(compacting.running, true, 'and it is the same turn `init` would have opened');
  });

  it('acts on no other state word', () => {
    // `requires_action` is not a synonym for `waiting` — the CLI raises it for
    // dialogs that never reach this pipe, and a card reading WAITING with
    // nothing in the dock to answer is unanswerable, so `pending` stays the
    // sole author of that word.
    const busy = run([INIT, delta('working')]);
    for (const state of ['requires_action', 'compacting']) {
      assert.equal(run([stateEvent(state)], busy), busy, state);
    }
    assert.equal(run([{ type: 'system', subtype: 'session_state_changed' }], busy), busy);
  });
});

/**
 * Claude's `result`, in the shapes 2.1.289 sent (protocol.md, "`terminal_reason`
 * on a finished turn…"). `subtype` is `success` on every failure, so each of
 * these states it to prove it is not what is read.
 */
describe('Claude’s result, classified', () => {
  const ended = (fields: Record<string, unknown>) =>
    run([INIT, { type: 'result', ...fields }]).lastOutcome;
  const failure = (status: number | null) => ({
    subtype: 'success',
    is_error: true,
    api_error_status: status,
    stop_reason: 'stop_sequence',
    terminal_reason: 'api_error'
  });

  it('reads every could-not-run turn as an error, signed out included', () => {
    for (const status of [529, 403, 400, null]) {
      assert.equal(ended(failure(status)), 'error', `api_error_status ${status}`);
    }
  });

  it('reads a finished turn as done', () => {
    const fields = { subtype: 'success', is_error: false, terminal_reason: 'completed' };
    assert.equal(ended(fields), 'done');
  });

  it('reads both interrupts as interrupted', () => {
    for (const reason of ['aborted_streaming', 'aborted_tools']) {
      const fields = { subtype: 'error_during_execution', is_error: true, terminal_reason: reason };
      assert.equal(ended(fields), 'interrupted', reason);
    }
  });

  it('leaves an unknown or missing terminal_reason unclassified', () => {
    assert.equal(ended({ subtype: 'success', terminal_reason: 'max_turns' }), undefined);
    assert.equal(ended({ subtype: 'success', is_error: false }), undefined);
    assert.equal(ended({ subtype: 'error_during_execution', is_error: true }), undefined);
  });

  it('keeps the error through the idle that trails it', () => {
    const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
    const state = run([INIT, { type: 'result', ...failure(529) }, idle]);
    assert.equal(state.lastOutcome, 'error');
    assert.equal(state.status, 'idle');
  });
});

describe('conversation_reset', () => {
  it('drops what belonged to the conversation and keeps what belongs to the session', () => {
    // A `/clear` ends the conversation and leaves the process alone.
    const started = run([
      { type: 'system', subtype: 'init', session_id: 'first', cwd: '/repo/app' }
    ]);
    const talking = {
      ...started,
      firstPrompt: 'what the title came from',
      title: 'a generated name',
      pending: [{ requestId: 'r1', toolName: 'Bash' }] as never
    };

    const cleared = run([{ type: 'conversation_reset' }], talking);

    assert.equal(cleared.firstPrompt, undefined);
    assert.equal(cleared.title, undefined, 'a name derived from a prompt nobody can scroll to');
    // `pending` is deliberately left alone — the reason is on `cleared`.
    assert.deepEqual(cleared.pending, talking.pending);
    assert.equal(cleared.status, talking.status);
    // The process did not change; the following `init` names the new one.
    assert.equal(cleared.sessionId, 'first');
    assert.equal(cleared.originCwd, '/repo/app');
  });

  it('keeps a stated name, which the CLI keeps across a /clear too', () => {
    // `sessions/<pid>.json` holds the name under the new id and the fresh
    // transcript restamps `custom-title` (2.1.258) — a card that dropped ours
    // would be the one reader on the machine that forgot.
    const named = live.withStated(
      run([{ type: 'system', subtype: 'init', session_id: 'first', cwd: '/repo/app' }]),
      'Own the stated name'
    );
    const cleared = run([{ type: 'conversation_reset' }], named);
    assert.equal(cleared.stated, 'Own the stated name');
  });

  it('lets the following init name the new conversation', () => {
    const state = run([
      { type: 'system', subtype: 'init', session_id: 'first', cwd: '/repo/app' },
      { type: 'conversation_reset' },
      { type: 'system', subtype: 'init', session_id: 'second', cwd: '/repo/app' }
    ]);
    assert.equal(state.sessionId, 'second');
    // A clear is a new conversation and begins where it is minted.
    assert.equal(state.originCwd, '/repo/app');
  });
});

/**
 * The window a session is in — asked for at the launch line, stated by the wire.
 *
 * The asymmetry is the feature: 200k can be pinned and 1M can only be
 * requested, so a session that asked for 1M and was held to 200k has both
 * figures and they disagree. Frames are written in the CLI's own spelling and
 * read through `readFrame`, so these cannot agree with the reducer about a
 * field name the CLI does not use.
 */
describe('the window a session runs in', () => {
  const started = (window?: number) =>
    live.initial({ cwd: '/repo/app', startedAt: 1000, model: 'claude-opus-5', window });

  const ran = (model: string, contextWindow: number) => [
    { type: 'system', subtype: 'init', model, session_id: 's1', cwd: '/repo/app' },
    { type: 'result', modelUsage: { [model]: { contextWindow } } }
  ];

  it('holds what the launch asked for before any turn has run', () => {
    const state = started(1_000_000);
    assert.equal(state.windowAsked, 1_000_000);
    assert.equal(state.windowStated, undefined, 'nothing has stated one yet');
  });

  it('takes what the wire states, keeping what was asked beside it', () => {
    // The mismatch this whole task exists to make visible: a `[1m]` launch on an
    // account that does not carry the entitlement runs at 200k, silently, with
    // no error anywhere.
    const after = run(ran('claude-opus-5', 200_000), started(1_000_000));
    assert.equal(after.windowAsked, 1_000_000);
    assert.equal(after.windowStated, 200_000);
  });

  it('agrees with itself when the account granted what was asked', () => {
    const after = run(ran('claude-opus-5', 1_000_000), started(1_000_000));
    assert.equal(after.windowAsked, 1_000_000);
    assert.equal(after.windowStated, 1_000_000);
  });

  /** A `[1m]` launch reports `modelUsage` under the unsuffixed spelling on some
   *  models, so the session's own key is looked up with the suffix off too. */
  it('reads the entry keyed with the suffix dropped', () => {
    const wires = [
      { type: 'system', subtype: 'init', model: 'claude-opus-5[1m]', session_id: 's1' },
      { type: 'result', modelUsage: { 'claude-opus-5': { contextWindow: 1_000_000 } } }
    ];
    assert.equal(run(wires, started(1_000_000)).windowStated, 1_000_000);
  });

  /**
   * The third key, and the reading that needs it: a session answering as
   * `claude-opus-4-5-20251101` is billed under `claude-opus-4-5`, which neither
   * the reading itself nor `base()` reaches — `base()` strips a `[…]` suffix
   * and nothing else. Observed 2026-08-29 as a card stuck on `31k used`. The
   * catalog names the key; the figure is still this turn's own.
   */
  it('reads the entry keyed under the id behind a dated reading', () => {
    const wires = [
      { type: 'system', subtype: 'init', model: 'claude-opus-4-5-20251101', session_id: 's1' },
      { type: 'result', modelUsage: { 'claude-opus-4-5': { contextWindow: 200_000 } } }
    ];
    assert.equal(run(wires).windowStated, 200_000);
  });

  /** `modelUsage` carries every model the turn billed. A subagent on a smaller
   *  window is the CLI's business, not this card's. */
  it('ignores a window keyed to another model', () => {
    const wires = [
      { type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's1' },
      {
        type: 'result',
        modelUsage: {
          'claude-opus-5': { contextWindow: 1_000_000 },
          'claude-haiku-4-5': { contextWindow: 200_000 }
        }
      }
    ];
    assert.equal(run(wires, started(1_000_000)).windowStated, 1_000_000);
  });

  it('states one even for a start that asked for nothing', () => {
    // Every session before this shipped, and every start from a stored model
    // with no window: it asks for nothing and still learns what it got.
    const after = run(ran('claude-opus-5', 1_000_000));
    assert.equal(after.windowAsked, undefined);
    assert.equal(after.windowStated, 1_000_000);
  });
});

describe('initial', () => {
  it('keeps the pick and the reading apart once init states one', () => {
    const start = live.initial({ cwd: '/repo/app', startedAt: 1000, model: 'opus[1m]' });
    const after = reduce.reduce(start, {
      type: 'system',
      subtype: 'init',
      sessionId: 'abc-123',
      cwd: '/repo/app',
      model: 'claude-opus-5[1m]'
    } as never);
    assert.equal(after.model, 'claude-opus-5[1m]');
    assert.equal(after.modelPick, 'opus[1m]');
  });
  it('keeps the spelling init gave when the message frame drops the suffix', () => {
    // One session that never moved, stating itself twice
    // (`docs/reference/cli_state/claude/protocol.md`). The suffix is what the
    // context window is keyed by and what tells the two Opus rows apart, so the
    // shorter spelling is dropped rather than written over the longer one.
    const start = live.initial({ cwd: '/repo/app', startedAt: 1000 });
    const init = reduce.reduce(start, {
      type: 'system',
      subtype: 'init',
      cwd: '/repo/app',
      model: 'claude-opus-5[1m]'
    } as never);
    const after = reduce.reduce(init, {
      type: 'stream_event',
      event: 'message_start',
      model: 'claude-opus-5'
    } as never);
    assert.equal(after.model, 'claude-opus-5[1m]');
  });
  it('still moves the reading when a turn states another model', () => {
    const start = live.initial({ cwd: '/repo/app', startedAt: 1000, model: 'opus[1m]' });
    const init = reduce.reduce(start, {
      type: 'system',
      subtype: 'init',
      cwd: '/repo/app',
      model: 'claude-haiku-4-5-20251001'
    } as never);
    assert.equal(init.model, 'claude-haiku-4-5-20251001');
  });
  it('leaves the seeded transcript alone when init restates the same id', () => {
    // A string that is not Claude's derivation: `reduce`'s `!state.transcript`
    // arm would silently re-derive and this would pass for the wrong reason.
    const start = live.initial({
      cwd: '/repo/app',
      startedAt: 1000,
      sessionId: 'abc-123',
      transcript: '/tmp/seeded.jsonl'
    });
    const after = reduce.reduce(start, {
      type: 'system',
      subtype: 'init',
      sessionId: 'abc-123',
      cwd: '/repo/app'
    } as never);
    assert.equal(after.transcript, '/tmp/seeded.jsonl');
    assert.equal(after.sessionId, 'abc-123');
  });
});
