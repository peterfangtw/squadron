import * as assert from 'node:assert/strict';

import { before, describe, it } from 'node:test';

import type { TurnOutcome } from '../../core/events';

import { DEFAULT_WARM_POLICY, type WarmPolicy } from '../../core/warm_policy';

import { win } from '../helpers';

import {
  INIT,
  Live,
  RESULT,
  askRequest,
  delta,
  live,
  messageStart,
  run,
  setup,
  writeRequest
} from './live_helpers';

before(setup);

describe('initial', () => {
  it('is a whole session before a single frame exists', () => {
    // The normal case: a session spawned with no prompt says nothing at all
    // until its first turn, because even `init` follows the first message. A
    // card has to be renderable from this alone.
    const state = live.initial({ cwd: '/repo/app', startedAt: 1000 });
    assert.equal(state.status, 'idle');
    assert.equal(state.cwd, '/repo/app');
    assert.equal(state.startedAt, 1000);
    assert.equal(state.sessionId, undefined);
    assert.equal(state.model, undefined);
    assert.equal(state.transcript, undefined);
    assert.deepEqual(state.pending, []);
  });
  it('does not invent a transcript from a session id', () => {
    // Brand three inherits whatever this function derives. A sessionId with
    // no path is the leak's inverse — Claude `connect` hands the file, Grok
    // resume does, a mint that is not a load does not.
    const state = live.initial({
      cwd: '/repo/app',
      startedAt: 1000,
      sessionId: 'abc-123'
    });
    assert.equal(state.sessionId, 'abc-123');
    assert.equal(state.transcript, undefined);
  });
  it('keeps a transcript the caller handed', () => {
    const state = live.initial({
      cwd: '/repo/app',
      startedAt: 1000,
      sessionId: 'abc-123',
      transcript: '/tmp/seeded.jsonl'
    });
    assert.equal(state.transcript, '/tmp/seeded.jsonl');
  });
  /**
   * The other half of a start that knows something the pipe has not said yet.
   * `--model` was passed, the session is on it, and nothing will state it until
   * somebody types — which is the whole window in which a new session's model
   * control had nothing to draw.
   */
  it('knows the model it was started on before it has said anything', () => {
    const state = live.initial({ cwd: '/repo/app', startedAt: 1000, model: 'opus[1m]' });
    assert.equal(state.modelPick, 'opus[1m]');
    // Not a reading, and never promoted into one: the card falls back to this
    // pick until the CLI names a model, rather than writing the pick into
    // `model` itself.
    assert.equal(state.model, undefined);
  });
  it('carries the pick onto the card it publishes', () => {
    // The hop to every other window: `toSession` is what `published.ts` writes,
    // so a remote card's pill resolves the same row this one does.
    const state = live.initial({ cwd: '/repo/app', startedAt: 1000, model: 'opus[1m]' });
    const card = live.toSession(
      state,
      { pid: 7, startedAt: 1000, updatedAt: 1000, brand: 'claude' },
      'w'
    );
    assert.equal(card.modelPick, 'opus[1m]');
  });
  it('takes a pick the panel made, and nothing else', () => {
    const start = live.initial({ cwd: '/repo/app', startedAt: 1000, model: 'opus[1m]' });
    const after = live.pickModel(start, 'haiku');
    assert.equal(after.modelPick, 'haiku');
    // Same value, same object: a repaint is what a new state costs.
    assert.equal(live.pickModel(after, 'haiku'), after);
  });
});

describe('answered', () => {
  it('removes the one request and leaves the others', () => {
    const state = run([INIT, askRequest, writeRequest]);
    const after = live.answered(state, 'req-1');
    assert.deepEqual(
      after.pending.map((p) => p.requestId),
      ['req-2']
    );
    assert.equal(after.status, 'waiting', 'still blocked on the second');
    assert.equal(live.answered(after, 'req-2').status, 'busy');
  });

  it('is unmoved by a request it is not holding', () => {
    const state = run([INIT, askRequest]);
    assert.equal(live.answered(state, 'nobody'), state);
  });
});

describe('withTitle', () => {
  // Nothing on the pipe pushes a name: a print-mode session is never titled of
  // its own accord, so the only one it has is what a round trip asked for.

  it('names the session from what came back', () => {
    assert.equal(
      live.withTitle(run([]), { title: 'Trace the missing cards' }).title,
      'Trace the missing cards'
    );
  });

  it('leaves the state alone when the model declined to name it', () => {
    const state = run([]);
    // Observed shape: the CLI answers `{title: null}` rather than erroring, and
    // a card falls back to its directory rather than showing a blank.
    assert.equal(live.withTitle(state, { title: null }), state);
    assert.equal(live.withTitle(state, { title: '  ' }), state);
    assert.equal(live.withTitle(state, undefined), state);
  });
});

describe('withStated', () => {
  // A statement, not a reading — what a person or an agent said the session is
  // called, true from the moment it is made whether or not any CLI agrees.

  it('takes what somebody said the session is called', () => {
    assert.equal(live.withStated(run([]), 'Own the stated name').stated, 'Own the stated name');
  });

  it('declines a blank rather than emptying the name a card wears', () => {
    const state = run([]);
    assert.equal(live.withStated(state, ''), state);
    assert.equal(live.withStated(state, '   '), state);
  });

  it('is identity when the name has not moved, so no repaint is owed', () => {
    const named = live.withStated(run([]), 'Own the stated name');
    assert.equal(live.withStated(named, 'Own the stated name'), named);
    assert.equal(live.withStated(named, '  Own the stated name  '), named);
  });
});

describe('withExit', () => {
  it('leaves a card that says the session is gone', () => {
    const state = live.withExit(
      live.enqueue(run([INIT, delta('half a th'), askRequest]), {
        id: 'x',
        text: 'later',
        queuedAt: 1
      }),
      {
        code: null,
        signal: 'SIGKILL'
      }
    );
    assert.deepEqual(state.exit, { code: null, signal: 'SIGKILL' });
    assert.equal(state.status, 'idle');
    assert.deepEqual(state.pending, [], 'answering into a dead child is answering into nothing');
    assert.deepEqual(state.queued, [], 'nothing queued will ever run now');
    assert.equal(state.sessionId, 'sess-1', 'what it was is still worth showing');
  });

  it('is applyEvent’s exit arm', () => {
    const state = live.enqueue(run([INIT, delta('half a th'), askRequest]), {
      id: 'x',
      text: 'later',
      queuedAt: 1
    });
    const exit = { code: null, signal: 'SIGKILL' };
    assert.deepEqual(live.withExit(state, exit), live.applyEvent(state, { kind: 'exit', ...exit }));
  });
});

describe('withUsage', () => {
  it('holds the last normalized reading when no new reading arrives', () => {
    const state = live.withUsage(
      run([INIT]),
      { windows: [{ id: 'session', short: '5h', pct: 3 }] },
      1_700_000
    );
    assert.equal(win(state.usage, 'session')?.pct, 3);
    assert.equal(live.withUsage(state, undefined, 1_800_000), state);
  });
});

describe('toSession', () => {
  /** What the window holding the pipe knows and no frame states. */
  const held = { pid: 100, startedAt: 1000, updatedAt: 2000, brand: 'claude' as const };

  it('takes the reducer’s status word, and the window it was given', () => {
    const card = live.toSession(run([INIT]), held, 'win-1');
    // `busy`, because an `init` is the first frame of a turn — the reducer's
    // word verbatim, which is the whole rule this carries.
    assert.equal(card.status, 'busy');
    assert.equal(card.windowId, 'win-1');
    assert.deepEqual(card.control, {
      canControl: true,
      owner: { kind: 'window', windowId: 'win-1' }
    });
    assert.equal(card.source, 'owned');
    assert.equal(card.background, undefined);
    assert.equal(card.pid, 100);
    assert.equal(card.startedAt, 1000);
    assert.equal(card.updatedAt, 2000);
    assert.equal(card.sessionId, 'sess-1');
    assert.equal(card.model, 'claude-opus-5');
    assert.equal(card.permissionMode, 'acceptEdits');
    assert.equal(card.hasCommand, false);
  });

  it('says unknown once the child is gone, whatever it was doing', () => {
    // A card for a dead session states that it is dead rather than that it is
    // idle: `withExit` leaves the reducer's own word behind, and the twin on
    // disk cannot arbitrate for an owned session either.
    const ended = live.withExit(run([INIT, delta('working')]), { code: 0, signal: null });
    assert.equal(ended.status, 'idle');
    const card = live.toSession(ended, held, 'win-1');
    assert.equal(card.status, 'unknown');
    assert.deepEqual(card.control, {
      canControl: true,
      owner: { kind: 'window', windowId: 'win-1' }
    });
  });

  it('records which transport ending latched the exit', () => {
    // Two of the three endings are not a death — a card reading `unknown` says
    // only that the exit was latched, and this is what says which callback did
    // it. Never drawn; the host logs it on the edge.
    const stdin = live.withExit(run([INIT]), { code: null, signal: null, source: 'stdin' });
    assert.equal(stdin.unknownFrom, 'exit:stdin');
    assert.equal(live.toSession(stdin, held, 'win-1').status, 'unknown');
    const real = live.withExit(run([INIT]), { code: 0, signal: null, source: 'exit' });
    assert.equal(real.unknownFrom, 'exit:exit');
    // A caller with nothing to state still leaves a reading behind, rather than
    // the absence a grep cannot tell from a card that never went unknown.
    assert.equal(
      live.withExit(run([INIT]), { code: 0, signal: null }).unknownFrom,
      'exit:unstated'
    );
  });

  it('records the wire’s own word when a brand states unknown', () => {
    // No exit here at all: the reducer is told `unknown` and the card wears it,
    // which is the case that used to leave nothing behind to attribute.
    const said = live.applyEvent(run([INIT]), {
      kind: 'status',
      status: 'unknown',
      native: 'notLoaded'
    });
    assert.equal(said.status, 'unknown');
    assert.equal(said.exit, undefined);
    assert.equal(said.unknownFrom, 'status:notLoaded');
  });

  it('names what a session is blocked on, by which kind of request it is', () => {
    assert.equal(live.toSession(run([INIT]), held, 'w').waitingFor, undefined);
    assert.equal(live.toSession(run([INIT, askRequest]), held, 'w').waitingFor, 'input needed');
    assert.equal(
      live.toSession(run([INIT, writeRequest]), held, 'w').waitingFor,
      'permission prompt'
    );
  });

  it('reports the oldest open request, not the newest', () => {
    // `pending` is oldest-first, and the card speaks for the one a person is
    // actually looking at.
    const both = run([INIT, askRequest, writeRequest]);
    assert.equal(live.toSession(both, held, 'w').waitingFor, 'input needed');
  });

  it('falls back to the directory and the pid when nothing has named it', () => {
    const card = live.toSession(run([INIT]), held, 'w');
    assert.equal(card.name, 'app-2s');
    assert.equal(card.nameSource, 'derived', 'so displayName folds it to agent-2s');
  });

  it('takes the generated title once the CLI has written one', () => {
    const titled = live.withTitle(run([INIT]), { title: 'Fix the fold' });
    const card = live.toSession(titled, held, 'w');
    assert.equal(card.name, 'Fix the fold');
    assert.equal(card.nameSource, 'generated');
  });

  it('keeps a name given at the spawn, and marks it explicit by omission', () => {
    // A derived name spells `nameSource` out and an explicit one omits it, which
    // is the CLI's own convention — so the session file this session writes and
    // the card synthesised here agree. Only a name somebody chose reaches
    // `held.name`; the prompt's first line is `placeholder` below.
    const titled = live.withTitle(run([INIT]), { title: 'Fix the fold' });
    const card = live.toSession(titled, { ...held, name: 'nightly' }, 'w');
    assert.equal(card.name, 'nightly');
    assert.equal(card.nameSource, undefined);
  });

  it('wears the prompt until a title arrives, then the title', () => {
    // The crop is a placeholder, not a decision, so the CLI's own answer
    // replaces it — and until 2026-09-23 it never did, because the crop went
    // out as `--name` and stopped every brand from producing one at all.
    const spawned = { ...held, placeholder: 'seems like the sessions are no lon…' };
    const before = live.toSession(run([INIT]), spawned, 'w');
    assert.equal(before.name, 'seems like the sessions are no lon…');
    assert.equal(before.nameSource, 'prompt', 'so nothing reads it as a statement');

    const titled = live.withTitle(run([INIT]), { title: 'Fix the fold' });
    const after = live.toSession(titled, spawned, 'w');
    assert.equal(after.name, 'Fix the fold');
    assert.equal(after.nameSource, 'generated');
  });

  it('keeps an explicit name over both the prompt and a title', () => {
    const titled = live.withTitle(run([INIT]), { title: 'Fix the fold' });
    const card = live.toSession(
      titled,
      { ...held, name: 'nightly', placeholder: 'do the thing' },
      'w'
    );
    assert.equal(card.name, 'nightly');
  });

  it('wears a stated name over the one it was spawned under', () => {
    // The rung this exists for: a rename taken a moment ago, which no file on
    // disk knows about yet and which two brands out of three never echo back.
    const renamed = live.withStated(run([INIT]), 'Own the stated name');
    const card = live.toSession(renamed, { ...held, name: 'nightly' }, 'w');
    assert.equal(card.name, 'Own the stated name');
    assert.equal(card.nameSource, undefined, 'so displayName prints it verbatim');
  });

  it('outranks a generated title that arrives after it', () => {
    // `generate_session_title` is asked for on a latch of its own and answers
    // whenever the model gets to it, so the answer can land behind a rename.
    const renamed = live.withStated(run([INIT]), 'Own the stated name');
    const late = live.withTitle(renamed, { title: 'Fix the fold' });
    assert.equal(live.toSession(late, held, 'w').name, 'Own the stated name');
  });

  it('carries a rename that arrived before the first init', () => {
    // Nothing to key a store entry by yet — a promptless session has no id
    // until somebody types — so the live half is the whole record until then.
    const early = live.withStated(live.initial({ cwd: '/repo/app', startedAt: 1000 }), 'Early');
    const card = live.toSession(early, held, 'w');
    assert.equal(card.sessionId, '');
    assert.equal(card.name, 'Early');
    assert.equal(card.nameSource, undefined);
  });

  it('states a context reading one way or the other, never both', () => {
    // A percentage is what a card draws; the token count is only what it falls
    // back to, and stating both would leave two readings to disagree.
    const pct = live.toSession({ ...run([INIT]), contextPct: 12, contextTokens: 900 }, held, 'w');
    assert.equal(pct.contextPct, 12);
    assert.equal(pct.contextTokens, undefined);
    const tokens = live.toSession({ ...run([INIT]), contextTokens: 900 }, held, 'w');
    assert.equal(tokens.contextTokens, 900);
  });

  it('carries the account reading that came off the wire, stamped', () => {
    const state = live.withUsage(
      run([INIT]),
      {
        windows: [
          { id: 'session', short: '5h', pct: 3 },
          { id: 'weekly', short: 'wk' }
        ]
      },
      1_700_000
    );
    const reading = live.toSession(state, held, 'w').rateLimits;
    // Stamped on the window as well as on the reading: one answer can carry a
    // figure for one window and none for the other, and the store keeps the
    // newest figure per window rather than taking a reading whole.
    assert.deepEqual(win(reading, 'session'), {
      id: 'session',
      short: '5h',
      pct: 3,
      at: 1_700_000
    });
    // The stamp is the caller's, and it is what the store ranks this against.
    assert.equal(reading?.at, 1_700_000);
    assert.deepEqual(win(reading, 'weekly'), { id: 'weekly', short: 'wk', at: 1_700_000 });
  });

  it('draws a session that has said nothing at all', () => {
    // The promptless start: no `init`, so no id, no model and no transcript, and
    // every consumer still has a card.
    const card = live.toSession(live.initial({ cwd: '/repo/app', startedAt: 1000 }), held, 'w');
    assert.equal(card.sessionId, '');
    assert.equal(card.transcript, '');
    assert.equal(card.model, undefined);
    assert.equal(card.status, 'idle');
  });
});

describe('the last turn’s outcome', () => {
  const held = { pid: 100, startedAt: 1000, updatedAt: 2000, brand: 'claude' as const };
  const outcome = (state: ReturnType<Live['initial']>) =>
    live.toSession(state, held, 'w').turnOutcome;
  const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
  // Stated as the event rather than as a `result`: what Claude's `result` hands
  // `endTurn` is that brand's own classification, read in its own reducer.
  const failed = () => live.applyEvent(run([INIT]), { kind: 'turn-end', outcome: 'error' });

  it('starts without one, and a card states none', () => {
    const fresh = live.initial({ cwd: '/repo/app', startedAt: 1000 });
    assert.equal(fresh.lastOutcome, undefined);
    assert.ok(!('turnOutcome' in live.toSession(fresh, held, 'w')), 'absent, not undefined');
    assert.equal(outcome(run([INIT, RESULT])), undefined, 'a close that states none');
  });

  it('records the outcome a turn-end states', () => {
    const state = failed();
    assert.equal(outcome(state), 'error');
    assert.equal(state.status, 'idle');
  });

  it('keeps it through every close behind it that states none', () => {
    // Claude's `idle` lands behind its `result`; a second, unclassified close.
    const state = failed();
    assert.equal(outcome(run([idle], state)), 'error');
    assert.equal(outcome(live.applyEvent(state, { kind: 'turn-end' })), 'error');
    assert.equal(outcome(live.applyEvent(state, { kind: 'status', status: 'idle' })), 'error');
    const unknown = live.applyEvent(state, { kind: 'status', status: 'unknown' });
    assert.equal(outcome(unknown), 'error');
  });

  it('records one stated after a close already ended the turn', () => {
    // Codex: `systemError` ends the turn, then `turn/completed failed` says why.
    const closed = live.applyEvent(run([INIT]), {
      kind: 'status',
      status: 'unknown',
      native: 'systemError'
    });
    assert.equal(closed.running, false);
    assert.equal(outcome(closed), undefined);
    assert.equal(outcome(live.applyEvent(closed, { kind: 'turn-end', outcome: 'error' })), 'error');
    // Grok: the notification and the prompt reply both close, both stating it.
    const twice = live.applyEvent(failed(), { kind: 'turn-end', outcome: 'error' });
    assert.equal(outcome(twice), 'error');
  });

  it('keeps the last through an exit that states none', () => {
    const exited = live.withExit(failed(), { code: 1, signal: null });
    assert.equal(outcome(exited), 'error');
    assert.equal(live.toSession(exited, held, 'w').status, 'unknown');
  });

  it('clears it when the next turn begins, through every opener', () => {
    const state = failed();
    // Claude's: `init`, the CLI's own `running`, a frame mid-turn.
    assert.equal(outcome(run([INIT], state)), undefined);
    const running = { type: 'system', subtype: 'session_state_changed', state: 'running' };
    assert.equal(outcome(run([running], state)), undefined);
    assert.equal(outcome(run([delta('x')], state)), undefined);
    // Every other brand's: their busy word, or a product event of the turn.
    assert.equal(outcome(live.applyEvent(state, { kind: 'status', status: 'busy' })), undefined);
    assert.equal(outcome(live.applyEvent(state, { kind: 'text', text: 'x' })), undefined);
  });

  it('is left alone by a request opening and being answered', () => {
    const asked = run([askRequest], failed());
    assert.equal(asked.status, 'waiting');
    assert.equal(outcome(asked), 'error');
    assert.equal(outcome(live.answered(asked, 'req-1')), 'error');
    assert.equal(
      outcome(run([{ type: 'control_cancel_request', request_id: 'req-1' }], asked)),
      'error'
    );
    const opened = live.applyEvent(failed(), { kind: 'waiting', requestId: 'p', open: true });
    const closed = live.applyEvent(opened, { kind: 'waiting', requestId: 'p', open: false });
    assert.equal(outcome(opened), 'error');
    assert.equal(outcome(closed), 'error');
  });

  it('is left alone by echoes and a retry outside a turn', () => {
    const state = failed();
    assert.equal(outcome(run([{ type: 'user', isReplay: true }], state)), 'error');
    const retry = { type: 'system', subtype: 'api_retry', session_id: 'sess-1' };
    assert.equal(outcome(run([retry], state)), 'error');
    assert.equal(outcome(live.withStated(state, 'renamed')), 'error');
    assert.equal(outcome(live.applyEvent(state, { kind: 'title', title: 'titled' })), 'error');
    assert.equal(outcome(live.applyEvent(state, { kind: 'model', model: 'other' })), 'error');
  });

  it('is dropped by a /clear, with the conversation it was about', () => {
    assert.equal(outcome(run([{ type: 'conversation_reset' }], failed())), undefined);
  });

  it('is superseded by a written prompt, and the card stays idle', () => {
    const queued = live.enqueue(failed(), { id: 'a', text: 'try again', queuedAt: 1 });
    assert.equal(outcome(queued), 'error', 'a held message is not a dispatch');
    assert.equal(outcome(live.dismissQueued(queued, 'a')), 'error');
    const wrote = live.dequeueHead(queued);
    assert.equal(outcome(wrote), undefined);
    assert.equal(wrote.status, 'idle', 'not busy before the CLI says so');
    assert.equal(wrote.running, false);
  });
});

/**
 * A finish counted where every brand's turn end passes, so two observations
 * that both read busy — a turn ended and a held reply drained at once — still
 * show the finish as a rise. Its outcome rides with it, because the card's own
 * `turnOutcome` is cleared by the very turn that follows.
 */
describe('the turns that ended', () => {
  const held = { pid: 100, startedAt: 1000, updatedAt: 2000, brand: 'claude' as const };
  const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
  const end = (state: ReturnType<Live['initial']>, outcome?: 'done' | 'interrupted' | 'error') =>
    live.applyEvent(state, { kind: 'turn-end', ...(outcome ? { outcome } : {}) });

  it('starts at none', () => {
    const fresh = live.initial({ cwd: '/repo/app', startedAt: 1000 });
    assert.equal(fresh.turnsEnded, 0);
    assert.equal(fresh.endedOutcome, undefined);
  });

  it('counts a real turn once, and nothing for the idle behind its result', () => {
    assert.equal(run([INIT, RESULT]).turnsEnded, 1);
    assert.equal(run([INIT, RESULT, idle]).turnsEnded, 1);
    assert.equal(run([INIT, RESULT, idle, INIT, RESULT, idle]).turnsEnded, 2);
  });

  it('counts an interrupted turn, and keeps how it ended', () => {
    const cut = end(run([INIT]), 'interrupted');
    assert.equal(cut.turnsEnded, 1);
    assert.equal(cut.endedOutcome, 'interrupted');
  });

  it('counts nothing for a warm ping', () => {
    const done = end(run([INIT, messageStart]), 'error');
    const written = live.warmDrain(run([idle], done), { id: 'warm-1', text: 'ok', queuedAt: 1 });
    assert.equal(written.turnsEnded, 1);
    const pinged = run([INIT, RESULT, idle], written);
    assert.equal(pinged.warmTurn?.phase, 'closed', 'the ping ran and closed');
    assert.equal(pinged.turnsEnded, 1);
    assert.equal(pinged.endedOutcome, 'error', 'the ping’s outcome is not the last finish’s');
  });

  it('counts nothing for a turn an exit or an unknown status cut off', () => {
    const exited = live.withExit(run([INIT]), { code: null, signal: 'SIGTERM' });
    assert.equal(exited.turnsEnded, 0);
    const unknown = live.applyEvent(run([INIT]), { kind: 'status', status: 'unknown' });
    assert.equal(unknown.turnsEnded, 0);
    assert.equal(live.withExit(unknown, { code: 1, signal: null }).turnsEnded, 0);
  });

  it('counts nothing for a local command sent ahead of a prompt, then the prompt’s turn', () => {
    const before = run([INIT, RESULT, idle]);
    const effort = live.dequeueHead(
      live.enqueue(before, { id: 'e', text: '/effort high', queuedAt: 1, command: true })
    );
    // The CLI answers a local command with a synthetic turn and a `result`.
    const answered = run([INIT, RESULT, idle], effort);
    assert.equal(answered.turnsEnded, 1);
    const prompt = live.dequeueHead(live.enqueue(answered, { id: 'p', text: 'go', queuedAt: 2 }));
    assert.equal(run([INIT, RESULT, idle], prompt).turnsEnded, 2);
  });

  it('takes the effort an /effort it wrote ran at, since no frame restates one', () => {
    const before = run([INIT, RESULT, idle]);
    const written = live.dequeueHead(
      live.enqueue(before, {
        id: 'e',
        text: '/effort high',
        queuedAt: 1,
        command: true,
        target: { effort: 'high' }
      })
    );
    // The CLI's stale `idle` lands between our write and the command's turn.
    assert.equal(run([idle], written).effort, undefined, 'taken before the command ran');
    assert.equal(run([INIT, RESULT, idle], written).effort, 'high');
  });

  it('counts nothing for a command the CLI answers itself, typed at the desk', () => {
    // `num_turns: 0`: the model was never called (`cli_state/claude/commands.md`).
    const local = { ...RESULT, num_turns: 0, total_cost_usd: 0 };
    const typed: [string, unknown[]][] = [
      ['/clear', [{ type: 'conversation_reset', session_id: 'sess-1' }, INIT, local, idle]],
      ['/model haiku', [INIT, local, idle]],
      ['/usage', [INIT, local, idle]],
      ['/context', [INIT, local, idle]],
      ['/compact', [INIT, { type: 'system', subtype: 'compact_boundary' }, local, idle]]
    ];
    for (const [text, frames] of typed) {
      const before = run([INIT, RESULT, idle]);
      const sent = live.dequeueHead(live.enqueue(before, { id: 'c', text, queuedAt: 1 }));
      assert.equal(run(frames, sent).turnsEnded, 1, text);
    }
  });

  it('counts a turn that could not run, though the model was never called', () => {
    const before = run([INIT, RESULT, idle]);
    const sent = live.dequeueHead(live.enqueue(before, { id: 'p', text: 'go', queuedAt: 1 }));
    const refused = { ...RESULT, num_turns: 0, is_error: true, terminal_reason: 'api_error' };
    const after = run([INIT, refused, idle], sent);
    assert.equal(after.turnsEnded, 2);
    assert.equal(after.endedOutcome, 'error');
  });

  it('counts the failure a CLI names after its own unknown closed the turn', () => {
    // Codex: `systemError` ends the turn, then `turn/completed failed` says why.
    const closed = live.applyEvent(run([INIT]), {
      kind: 'status',
      status: 'unknown',
      native: 'systemError'
    });
    const failed = end(closed, 'error');
    assert.equal(failed.turnsEnded, 1);
    assert.equal(failed.endedOutcome, 'error');
    assert.equal(end(failed, 'error').turnsEnded, 1, 'a second statement counts nothing');
  });

  it('takes an outcome a later close of the same turn states', () => {
    // Grok: the notification closes the turn, the prompt reply says how.
    const closed = end(run([INIT]));
    assert.equal(closed.turnsEnded, 1);
    assert.equal(closed.endedOutcome, undefined, 'ended, nobody said how');
    const named = end(closed, 'error');
    assert.equal(named.turnsEnded, 1);
    assert.equal(named.endedOutcome, 'error');
  });

  it('forgets an older outcome when a turn ends without one', () => {
    const twice = end(run([INIT], end(run([INIT]), 'error')));
    assert.equal(twice.turnsEnded, 2);
    assert.equal(twice.endedOutcome, undefined);
  });

  it('keeps the outcome through everything that clears the card’s', () => {
    const failed = end(run([INIT]), 'error');
    const busy = live.applyEvent(failed, { kind: 'status', status: 'busy' });
    assert.equal(busy.lastOutcome, undefined);
    assert.equal(busy.endedOutcome, 'error');
    const wrote = live.dequeueHead(live.enqueue(failed, { id: 'a', text: 'again', queuedAt: 1 }));
    assert.equal(wrote.endedOutcome, 'error');
    assert.equal(run([{ type: 'conversation_reset' }], failed).endedOutcome, 'error');
  });

  it('publishes the count and the outcome on the card', () => {
    const card = live.toSession(end(run([INIT]), 'error'), held, 'w');
    assert.equal(card.turnsEnded, 1);
    assert.equal(card.endedOutcome, 'error');
    const quiet = live.toSession(run([INIT]), held, 'w');
    assert.equal(quiet.turnsEnded, 0);
    assert.ok(!('endedOutcome' in quiet), 'absent, not undefined');
  });
});

/**
 * `launchReach` is the launch line, and only the launch line.
 *
 * It was `windowReach` and `setModel` rewrote it, so it meant "how the current
 * pick was reached" — two readers keyed the fixed-for-life rule on it and both
 * went wrong after one switch. The rename is the fix; these pin what the name
 * now promises. The other half, that a switch leaves it alone, is
 * `claude_session.test.ts` — the write that moved it lived there.
 */
describe('launchReach', () => {
  it('carries the reach the launch line was composed with', () => {
    const state = live.initial({
      cwd: '/repo/app',
      startedAt: 1000,
      model: 'claude-opus-5',
      window: 200_000,
      windowReach: 'flag'
    });
    assert.equal(state.launchReach, 'flag');
  });

  it('is absent for a launch that reached no window of its own', () => {
    // Grok, a typed id, and every start before the window rode the line. The
    // absence blocks nothing: we cannot say what such a line can reach.
    const state = live.initial({ cwd: '/repo/app', startedAt: 1000, model: 'claude-opus-5' });
    assert.equal(state.launchReach, undefined);
  });

  it('rides onto the card, so another window’s dock gets the same answer', () => {
    const state = live.initial({
      cwd: '/repo/app',
      startedAt: 1000,
      model: 'claude-opus-5',
      window: 200_000,
      windowReach: 'flag'
    });
    const card = live.toSession(
      state,
      { pid: 100, startedAt: 1000, updatedAt: 2000, brand: 'claude' },
      'win-1'
    );
    assert.equal(card.launchReach, 'flag');
  });

  it('omits the key entirely when there is none, rather than setting it undefined', () => {
    // `views.promote` folds a record over a discovered twin with `{...twin,
    // ...record}`, so a key present-and-undefined erases what the twin knew.
    const state = live.initial({ cwd: '/repo/app', startedAt: 1000, model: 'claude-opus-5' });
    const card = live.toSession(
      state,
      { pid: 100, startedAt: 1000, updatedAt: 2000, brand: 'claude' },
      'win-1'
    );
    assert.ok(!('launchReach' in card), 'the key must not be present at all');
  });
});

describe('owned cache TTL', () => {
  const start = (oneHour: unknown, fiveMinutes: unknown) => ({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        usage: {
          cache_creation: {
            ephemeral_1h_input_tokens: oneHour,
            ephemeral_5m_input_tokens: fiveMinutes
          }
        }
      }
    }
  });
  const held = {
    pid: 10,
    startedAt: 1000,
    updatedAt: 2000,
    cacheAt: 3000,
    brand: 'claude' as const
  };
  it('times off the policy, whatever retention the wire reports', () => {
    const state = run([INIT, start(0, 1000)]);
    assert.deepEqual(live.toSession(state, held, 'w').cache, {
      ttlMs: 60 * 60_000,
      source: 'measured'
    });
    const fiveMinutes: WarmPolicy = {
      ...DEFAULT_WARM_POLICY,
      ttlMs: { ...DEFAULT_WARM_POLICY.ttlMs, claude: 5 * 60_000 }
    };
    assert.deepEqual(
      live.toSession(run([INIT, start(1000, 0)]), { ...held, warmPolicy: fiveMinutes }, 'w').cache,
      { ttlMs: 5 * 60_000, source: 'configured' }
    );
  });
  it('omits the cache stamp during ordinary work', () => {
    const state = run([INIT, start(0, 1000)]);
    assert.deepEqual(live.toSession(live.endTurn(state), held, 'w').cache, {
      ttlMs: 60 * 60_000,
      source: 'measured',
      at: 3000
    });
    assert.equal(live.toSession({ ...state, status: 'waiting' }, held, 'w').cache?.at, 3000);
  });
});

describe('pingFailed', () => {
  // Exhaustive against TurnOutcome: a new value fails this file and pingFailed.
  const failed: Record<TurnOutcome, boolean> = {
    done: false,
    interrupted: true,
    error: true
  };

  it('fails a warm ping only when the turn was interrupted or errored', () => {
    assert.equal(live.pingFailed(undefined), false);
    for (const outcome of Object.keys(failed) as TurnOutcome[]) {
      assert.equal(live.pingFailed(outcome), failed[outcome], outcome);
    }
  });
});

describe('the warm turn', () => {
  const held = {
    pid: 100,
    startedAt: 1000,
    updatedAt: 2000,
    cacheAt: 3000,
    brand: 'claude' as const
  };
  const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
  const ping = { id: 'warm-1', text: 'keep-alive', queuedAt: 1 };
  /** A finished real turn that failed, with its context stated, then a ping
   *  written onto it — the state every case below starts from. */
  const written = () => {
    const done = live.applyEvent(run([INIT, messageStart]), { kind: 'turn-end', outcome: 'error' });
    return live.warmDrain(run([idle], done), ping);
  };
  /** A cache read on the ping's first request, in the CLI's spelling. */
  const read = (tokens: number) => ({
    ...messageStart,
    event: {
      type: 'message_start',
      message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens }
      }
    }
  });

  it('is written with the prefix it has to find, outside the outbox', () => {
    const state = written();
    assert.deepEqual(state.warmTurn, { id: ping.id, phase: 'written', prefix: 28_317 });
    assert.equal(state.inFlight?.warm, true);
    assert.deepEqual(state.queued, []);
    assert.equal(live.warming(state), true);
    assert.equal(live.canDrain(state), false, 'nothing is written onto an ambiguous ping');
  });

  it('opens on the turn it started and keeps the last real outcome through it', () => {
    const state = run([INIT, delta('OK'), read(28_000)], written());
    assert.equal(state.warmTurn?.phase, 'open');
    assert.equal(state.running, true);
    assert.equal(state.lastOutcome, 'error');
    assert.equal(live.shownStatus(state), 'idle', 'maintenance is not work');
    assert.equal(live.canDrain(state), false);
  });

  it('closes on its result, and a trailing idle leaves it closed', () => {
    const closed = run([INIT, RESULT], written());
    assert.equal(closed.warmTurn?.phase, 'closed');
    assert.equal(closed.warmTurn?.failed, undefined);
    assert.equal(closed.lastOutcome, 'error', 'the ping’s success is not the card’s');
    assert.equal(live.canDrain(closed), true);
    assert.equal(live.warming(closed), false);
    assert.deepEqual(run([idle], closed).warmTurn, closed.warmTurn);
  });

  it('stays written through a stale idle that lands before the turn opens', () => {
    const state = run([idle], written());
    assert.equal(state.warmTurn?.phase, 'written');
    assert.equal(live.warming(state), true);
    assert.equal(state.inFlight?.warm, true);
  });

  it('is cleared by a real drain, which then supersedes the outcome as usual', () => {
    const closed = run([INIT, RESULT], written());
    const drained = live.dequeueHead(
      live.enqueue(closed, { id: 'real', text: 'go on', queuedAt: 2 })
    );
    assert.equal(drained.warmTurn, undefined);
    const turn = run([INIT], drained);
    assert.equal(turn.lastOutcome, undefined);
    assert.equal(run([RESULT, idle], turn).warmTurn, undefined);
  });

  it('is cleared by a turn the CLI starts itself after it closed', () => {
    const closed = run([INIT, RESULT], written());
    const self = run([INIT], closed);
    assert.equal(self.warmTurn, undefined);
    assert.equal(self.lastOutcome, undefined, 'real activity supersedes the outcome');
    assert.equal(live.shownStatus(self), 'busy');
  });

  it('marks a failed ping without touching the card’s outcome', () => {
    const opened = run([INIT], written());
    const failed = live.applyEvent(opened, { kind: 'turn-end', outcome: 'interrupted' });
    assert.deepEqual(failed.warmTurn, {
      id: ping.id,
      phase: 'closed',
      prefix: 28_317,
      failed: true
    });
    assert.equal(failed.lastOutcome, 'error');
  });

  it('is cut, not ended, by a refusal, until the brand admits the turn ended', () => {
    const cut = live.failWarm(run([INIT], written()));
    assert.equal(cut.warmTurn?.phase, 'open');
    assert.equal(cut.warmTurn?.failed, true);
    assert.equal(live.warming(cut), true);
    assert.equal(run([RESULT], cut).warmTurn?.failed, true, 'a later success does not clear it');
  });

  it('closes failed when the brand admits a write that never opened a turn', () => {
    const state = live.closeWarm(written(), true);
    assert.equal(state.warmTurn?.phase, 'closed');
    assert.equal(state.warmTurn?.failed, true);
    assert.equal(state.inFlight, undefined);
    assert.equal(live.closeWarm(state, false), state, 'idempotent');
  });

  for (const [label, from] of [
    ['written', () => written()],
    ['open', () => run([INIT], written())]
  ] as const) {
    it(`closes failed when the child exits while ${label}`, () => {
      const gone = live.applyEvent(from(), { kind: 'exit', code: 1, signal: null });
      assert.equal(gone.warmTurn?.phase, 'closed');
      assert.equal(gone.warmTurn?.failed, true);
      assert.equal(gone.lastOutcome, 'error');
      assert.equal(live.shownStatus(gone), 'unknown');
    });
  }

  it('carries only a live maintenance ping, independent of the warm preference', () => {
    const states = [run([]), written(), run([INIT], written()), run([INIT, RESULT], written())];
    for (const warm of [false, true]) {
      const cues = states.map((state) => live.toSession(state, { ...held, warm }, 'w').warming);
      assert.deepEqual(cues, [undefined, true, true, undefined]);
    }
  });

  it('draws an idle card with no blocker, its cache stamp and its last outcome', () => {
    const opened = run([INIT, read(28_000)], written());
    const asking = { ...opened, pending: [{ requestId: 'r', toolName: 'Bash' }] as never };
    const busy = live.applyEvent(asking, { kind: 'tool-start', name: 'Bash' });
    const card = live.toSession(busy, held, 'w');
    assert.equal(card.status, 'idle');
    assert.equal(card.waitingFor, undefined);
    assert.equal(card.activeTool, undefined);
    assert.equal(card.turnOutcome, 'error');
    assert.equal(card.cache?.at, 3000, 'the clock keeps counting while it warms');
  });

  it('reads as finished work to a wait, an end, the sound and the lease', async () => {
    // Each reads the status word alone, so the masked card is the whole contract:
    // no edge to beep or lease on, a wait over it resolves, an end may cut it.
    const { soundCue } = await import('../../ui/views');
    const { decide } = await import('../../core/awake');
    const { endPlan } = await import('../../cli/end_plan');
    const { resolveWaits } = await import('../../core/coordination/wait');
    const before = live.toSession(written(), held, 'w');
    const during = live.toSession(run([INIT, read(28_000)], written()), held, 'w');
    const after = live.toSession(run([INIT, read(28_000), RESULT, idle], written()), held, 'w');
    assert.equal(soundCue([before], [during]), undefined);
    assert.equal(soundCue([during], [after]), undefined);
    const lease = { power: undefined, now: 2500, enabled: true, holds: true };
    assert.equal(decide({ ...lease, sessions: [during] }).reason, 'idle');
    const caller = { ...during, pid: 1, sessionId: 'me' };
    const kid = { ...during, parentSessionId: 'me', source: 'owned' as const };
    assert.equal(endPlan({ pid: 100 }, [caller, kid], 'me').ok, true);
    const [resolved] = resolveWaits({
      waits: [
        { schema: 1, id: 'w', requesterPid: 1, members: [100], createdAt: 0, expiresAt: 9e15 }
      ],
      board: [{ pid: 100, status: during.status, hasCommand: during.hasCommand, ended: false }],
      now: 2500
    });
    assert.deepEqual(resolved?.members, [{ pid: 100, state: 'reported' }]);
  });

  it('reads the first cache read as its evidence, and only while it is the latest', () => {
    const opened = run([INIT, read(27_000), read(5)], written());
    assert.equal(opened.warmTurn?.cached, 27_000, 'the first request is what tests the cache');
    const closed = run([RESULT], opened);
    assert.equal(live.warmVerdict(closed.warmTurn ?? { phase: 'closed' }), 'hit');
    const real = live.dequeueHead(live.enqueue(closed, { id: 'r', text: 'go', queuedAt: 2 }));
    assert.equal(run([INIT, read(28_000)], real).warmTurn, undefined, 'a real turn charges none');
    assert.equal(live.applyEvent(run([]), { kind: 'cache-read', tokens: 9 }).warmTurn, undefined);
  });

  it('calls a tiny common-prefix read a miss, never a hit', () => {
    const verdict = (cached?: number, prefix?: number) =>
      live.warmVerdict({
        phase: 'closed',
        ...(cached === undefined ? {} : { cached }),
        ...(prefix === undefined ? {} : { prefix })
      });
    assert.equal(verdict(25_500, 28_317), 'hit');
    assert.equal(verdict(20_000, 28_317), 'partial');
    assert.equal(verdict(4_000, 28_317), 'miss', 'the tool list and system prompt alone');
    assert.equal(verdict(0, 28_317), 'miss');
    assert.equal(verdict(undefined, 28_317), 'unknown');
    assert.equal(verdict(4_000, undefined), 'unknown');
    assert.equal(verdict(4_000, 0), 'unknown');
  });

  it('is dropped with the conversation it belonged to', () => {
    assert.equal(run([{ type: 'conversation_reset' }], written()).warmTurn, undefined);
  });
});
