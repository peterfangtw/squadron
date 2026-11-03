import * as assert from 'node:assert/strict';

import { after, before, describe, it } from 'node:test';

import { linkDir, win } from '../helpers';

let userMessage: (typeof import('../../core/claude/frames'))['userMessage'];

let wrapMessage: (typeof import('../../core/coordination/send'))['wrapMessage'];

let wrapWait: (typeof import('../../core/coordination/send'))['wrapWait'];

let IDENTITY_NAMES: (typeof import('../../core/identity'))['IDENTITY_NAMES'];

import {
  adapter,
  AFTER_CLEAR,
  alive,
  ANSWERED,
  answeredError,
  answeredOk,
  BEFORE_CLEAR,
  claude,
  control,
  dispose,
  echoed,
  INTERRUPTED,
  MERGED,
  nowhere,
  open,
  ORDERED,
  Outbound,
  outbox,
  pipe,
  READOUT,
  record,
  recorded,
  RETURNED,
  setup,
  spoke,
  start,
  stub,
  turnStarted,
  until,
  waitForControl
} from './claude_session_helpers';
import * as executables from '../../core/platform/executables';

before(async () => {
  await setup();
  ({ userMessage } = await import('../../core/claude/frames'));
  ({ wrapMessage } = await import('../../core/coordination/send'));
  ({ wrapWait } = await import('../../core/coordination/send'));
  ({ IDENTITY_NAMES } = await import('../../core/identity'));
});

after(dispose);

describe('OwnedSession', () => {
  it('names the transcript from the session id before any frame', async () => {
    const { transcriptPath } = await import('../../core/claude/transcript');
    const { transport } = stub();
    const session = new claude.OwnedSession(transport, {
      cwd: '/repo/app',
      startedAt: 1000,
      sessionId: 'abc-123'
    });
    alive.push(session);
    assert.equal(session.state.transcript, transcriptPath('/repo/app', 'abc-123'));
  });

  it('names the transcript the CLI files for a cwd behind a symlink', async (t) => {
    // `/tmp` on macOS: the CLI slugs the real path, so the first `init` (which
    // keeps a pin it already has) must find the same file this one names.
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { transcriptPath } = await import('../../core/claude/transcript');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-link-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    await fs.mkdir(real);
    await linkDir(real, link);
    const { transport } = stub();
    const session = new claude.OwnedSession(transport, {
      cwd: link,
      startedAt: 1000,
      sessionId: 'abc-123'
    });
    alive.push(session);
    assert.equal(session.state.transcript, transcriptPath(real, 'abc-123'));
  });

  it('sends a turn without waiting for anything first', async () => {
    // The handshake is inverted: streaming input initialises on the first
    // message, so a client that waited for `init` would wait forever.
    const session = start();
    session.send('hello there');
    const busy = await until(session, 'the live message', (s) => s.words.includes('hello'));
    assert.equal(busy.status, 'busy');
    assert.equal(busy.sessionId, '11111111-2222-3333-4444-555555555555');
    assert.equal(busy.model, 'claude-opus-5');
    assert.match(busy.transcript ?? '', /\.jsonl$/);

    const done = await until(session, 'the turn to end', (s) => s.status === 'idle');
    assert.match(done.words, /hello/);
    const reply = session.thread
      .snapshot()
      .recent.exchanges.find(
        (row) => 'role' in row && row.role === 'assistant' && row.text === 'hello there'
      );
    assert.ok(reply && 'role' in reply);
    assert.equal(reply.cut, undefined, 'an ordinary reply completed');
    assert.equal(done.contextPct, 0, 'a hundred tokens of a million is none of it');
  });

  it('ends a turn whose result never came', async () => {
    // End to end through the real transport, because the whole of what is under
    // test is the plumbing: `childTransport` puts
    // `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` on the child's environment, and
    // the fake — like the real CLI — emits `session_state_changed` only if it
    // sees it. A card whose only exit from `busy` is a `result` sits on BUSY
    // forever when one goes missing, which is exactly what was observed in the
    // wild.
    const session = start();
    session.send('quiet please');
    const busy = await until(session, 'the live message', (s) => s.words.includes('quietly'));
    assert.equal(busy.status, 'busy');

    const done = await until(session, 'the turn to end', (s) => s.status === 'idle');
    assert.equal(done.running, false);
    assert.match(done.words, /quietly/, 'the thread keeps the words after idle');
    assert.deepEqual(session.thread.snapshot().tail, [], 'and no row is left streaming');
  });

  it('plants the fan-out on the child, so its own spawns inherit it', async () => {
    const session = start('gen1-session');
    session.send('origin');
    const state = await until(session, 'the echoed environment', (s) =>
      s.words.includes('origin=')
    );
    assert.match(state.words, /origin=gen1-session/);
  });

  it('deletes the var for a rootless session rather than leaving it inherited', async () => {
    // Asserted against a value on *this* process, because the child's env is
    // `{...process.env}` — an extension host booted from inside a session's own
    // shell carries the var, and "leave it off" would silently enrol every
    // rootless session it starts into that ancestor's fan-out.
    const was = process.env.SQUADRON_LINEAGE_ORIGIN;
    process.env.SQUADRON_LINEAGE_ORIGIN = 'an-ancestors-fan-out';
    try {
      const session = start();
      session.send('origin');
      const state = await until(session, 'the echoed environment', (s) =>
        s.words.includes('origin=')
      );
      assert.match(state.words, /origin=unset/);
    } finally {
      if (was === undefined) {
        delete process.env.SQUADRON_LINEAGE_ORIGIN;
      } else {
        process.env.SQUADRON_LINEAGE_ORIGIN = was;
      }
    }
  });

  // The CLI keeps an inherited `CLAUDE_CODE_ENTRYPOINT` (2.1.281's setter only
  // rewrites `cli` to `sdk-cli` under print mode), and discovery keeps a Claude
  // twin only when it says `sdk-cli` — so a host booted with `claude-vscode` in
  // its environment would strip every owned card of its twin.
  it('hands the child no inherited entrypoint, so it states its own', async () => {
    const was = process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode';
    try {
      const session = start();
      session.send('entrypoint');
      const state = await until(session, 'the echoed environment', (s) =>
        s.words.includes('entrypoint=')
      );
      assert.match(state.words, /entrypoint=unset/);
    } finally {
      if (was === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = was;
    }
  });

  // Measured 2026-09-02: no ordering of `ownSessionId`'s rungs is safe while an
  // ancestor's id survives the spawn — a host booted from one brand's shell tool
  // made every session it started answer to that brand's id, mis-parenting
  // lineage and charging another session's rate and pair caps.
  // Off `IDENTITY_NAMES` rather than a written-out list, which is the point of the
  // table: a brand added there is planted, echoed and asserted on with no edit
  // here, and the scrub cannot silently fall behind the read.
  it('hands the child no ancestor identity, whichever brand planted one', async () => {
    const was = new Map(IDENTITY_NAMES.map((name) => [name, process.env[name]]));
    for (const name of IDENTITY_NAMES) process.env[name] = `an-ancestor-${name}`;
    try {
      const session = start();
      session.send('whoami');
      const state = await until(session, 'the echoed environment', (s) =>
        s.words.includes('whoami ')
      );
      for (const name of IDENTITY_NAMES) assert.match(state.words, new RegExp(`${name}=unset`));
    } finally {
      for (const [name, value] of was) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('writes a merged delivery as one text block per message, images after their own', () => {
    const shot = { mediaType: 'image/png', data: 'AAA' };
    assert.deepEqual(
      userMessage([
        { text: 'first\n\n', images: [shot] },
        { text: '', images: [shot] },
        { text: 'last', images: [] }
      ]),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'first\n\n' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
            { type: 'text', text: 'last' }
          ]
        }
      }
    );
  });

  it('carries an image as a content block, with no file on disk', async () => {
    const session = start();
    session.send('a picture', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    const state = await until(session, 'the echoed turn', (s) => s.words.includes('image'));
    assert.match(state.words, /a picture \[1 image\]/);
  });

  it('answers an ask with labels, in any shape', async () => {
    // The multi-select in slot 2 is the shape the keystroke path refuses
    // outright: its submit button ends the whole ask, leaving what follows
    // unanswered. Here it is one response.
    const session = start();
    session.send('ask me');
    const waiting = await until(session, 'the ask', (s) => s.pending.length > 0);
    assert.equal(waiting.status, 'waiting');
    const request = waiting.pending[0];
    assert.equal(request?.ask, true);
    assert.equal(request?.questions?.length, 3);

    session.respond(request?.requestId ?? '', { allow: true, picks: [[0], [0, 2], [1]] });
    const answered = await until(session, 'the response echo', (s) => s.words.includes('RESPONSE'));
    assert.deepEqual(answered.pending, [], 'the card goes as the answer is sent');

    const response = echoed(answered) as {
      subtype: string;
      response: {
        behavior: string;
        decisionClassification: string;
        updatedInput: { answers: Record<string, unknown>; questions: unknown[] };
      };
    };
    assert.equal(response.subtype, 'success');
    assert.equal(response.response.behavior, 'allow');
    assert.equal(response.response.decisionClassification, 'user_temporary');
    assert.deepEqual(response.response.updatedInput.answers, {
      // Keyed by the full question text, which is what the CLI looks up. A
      // multi-select is an array — the CLI joins it for the model itself.
      'Which fruit?': 'Banana',
      'Which colours?': ['Red', 'Green'],
      'Which speed?': 'Slow'
    });
    assert.equal(
      response.response.updatedInput.questions.length,
      3,
      'the tool’s own input rides back untouched beside the answers'
    );
  });

  it('answers an ask in the reader’s own words, picking nothing', async () => {
    // The widget's `Other` row, as a field: a question with text and no pick is
    // answered by that text, and a multi-select's key stays an array.
    const session = start();
    session.send('ask me');
    const waiting = await until(session, 'the ask', (s) => s.pending.length > 0);
    session.respond(waiting.pending[0]?.requestId ?? '', {
      allow: true,
      picks: [[0], [], []],
      texts: ['', 'Whatever is in season', '  As slow as you like\n']
    });
    const answered = await until(session, 'the response echo', (s) => s.words.includes('RESPONSE'));
    const response = echoed(answered) as {
      response: { behavior: string; updatedInput: { answers: Record<string, unknown> } };
    };
    assert.equal(response.response.behavior, 'allow');
    assert.deepEqual(response.response.updatedInput.answers, {
      'Which fruit?': 'Banana',
      'Which colours?': ['Whatever is in season'],
      'Which speed?': 'As slow as you like'
    });
  });

  it('carries a note beside the pick it is about', async () => {
    // `annotations` rides on `updatedInput` beside `answers`, keyed the same
    // way, and the picked label is untouched by it — which is the property the
    // probe in `docs/reference/cli_state/claude/protocol.md` was run to establish.
    const session = start();
    session.send('ask me');
    const waiting = await until(session, 'the ask', (s) => s.pending.length > 0);
    session.respond(waiting.pending[0]?.requestId ?? '', {
      allow: true,
      picks: [[0], [0, 2], [1]],
      notes: ['  but only a ripe one\n', '', '   ']
    });
    const answered = await until(session, 'the response echo', (s) => s.words.includes('RESPONSE'));
    const response = echoed(answered) as {
      response: {
        updatedInput: {
          answers: Record<string, unknown>;
          annotations: Record<string, unknown>;
        };
      };
    };
    assert.deepEqual(response.response.updatedInput.annotations, {
      'Which fruit?': { notes: 'but only a ripe one' }
    });
    assert.deepEqual(
      response.response.updatedInput.answers,
      {
        'Which fruit?': 'Banana',
        'Which colours?': ['Red', 'Green'],
        'Which speed?': 'Slow'
      },
      'the note says something about the pick and nothing instead of it'
    );
  });

  it('writes no annotations at all when nothing was noted', async () => {
    // An empty object is a field the CLI has no reason to read.
    const session = start();
    session.send('ask me');
    const waiting = await until(session, 'the ask', (s) => s.pending.length > 0);
    session.respond(waiting.pending[0]?.requestId ?? '', {
      allow: true,
      picks: [[0], [0], [0]],
      notes: ['', '  ']
    });
    const answered = await until(session, 'the response echo', (s) => s.words.includes('RESPONSE'));
    const response = echoed(answered) as { response: { updatedInput: Record<string, unknown> } };
    assert.equal('annotations' in response.response.updatedInput, false);
  });

  it('denies an ask with the words that were typed at it', async () => {
    // "Reply instead" is the CLI's own `Chat about this`: a denial carrying
    // feedback, not a cancel. The turn survives and the model reads the words.
    const session = start();
    session.send('ask me');
    const waiting = await until(session, 'the ask', (s) => s.pending.length > 0);
    session.respond(waiting.pending[0]?.requestId ?? '', {
      allow: false,
      message: 'None of these — what I meant was the other repo.'
    });
    const state = await until(session, 'the response echo', (s) => s.words.includes('RESPONSE'));
    const response = echoed(state) as {
      response: { behavior: string; message: string; decisionClassification: string };
    };
    assert.equal(response.response.behavior, 'deny');
    assert.equal(
      response.response.message,
      'None of these — what I meant was the other repo.',
      'verbatim: the model is reading this, not a paraphrase of it'
    );
    assert.equal(response.response.decisionClassification, 'user_reject');
  });

  it('denies a permission prompt and says so truthfully', async () => {
    const session = start();
    session.send('write a file');
    const waiting = await until(session, 'the permission prompt', (s) => s.pending.length > 0);
    const request = waiting.pending[0];
    assert.equal(request?.ask, false);
    assert.equal(request?.label, 'notes.txt');

    session.respond(request?.requestId ?? '', { allow: false, message: 'Not that file.' });
    const state = await until(session, 'the response echo', (s) => s.words.includes('RESPONSE'));
    const response = echoed(state) as {
      response: { behavior: string; message: string; decisionClassification: string };
    };
    assert.equal(response.response.behavior, 'deny');
    assert.equal(response.response.message, 'Not that file.');
    assert.equal(response.response.decisionClassification, 'user_reject');
  });

  it('hands the CLI’s own suggestion back on an always-allow', async () => {
    // Echoed rather than composed by choice: `ruleContent` matching is the
    // CLI's syntax, and its suggestion is a known-correct rule for this call.
    const session = start();
    session.send('write a file');
    const waiting = await until(session, 'the permission prompt', (s) => s.pending.length > 0);
    session.respond(waiting.pending[0]?.requestId ?? '', { allow: true, always: true });
    const state = await until(session, 'the response echo', (s) => s.words.includes('RESPONSE'));
    const response = echoed(state) as {
      response: {
        behavior: string;
        decisionClassification: string;
        updatedInput: Record<string, unknown>;
        updatedPermissions: { type: string; destination: string }[];
      };
    };
    assert.equal(response.response.behavior, 'allow');
    assert.equal(response.response.decisionClassification, 'user_permanent');
    assert.deepEqual(response.response.updatedPermissions, [
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
    ]);
    assert.deepEqual(response.response.updatedInput, {
      file_path: '/tmp/notes.txt',
      content: 'hi'
    });
  });

  it('holds two prompts at once, and answering one leaves the other blocking', async () => {
    // Opportunistic in the IDE — the model batches its tool calls into separate
    // messages, so two may never be open together — but the wire allows it and
    // the fixture does it on demand. What must not happen is the second going
    // with the first: that leaves the session blocked on a request nothing on
    // screen can reach.
    const session = start();
    session.send('two writes');
    const waiting = await until(session, 'both prompts', (s) => s.pending.length === 2);
    assert.deepEqual(
      waiting.pending.map((p) => p.label),
      ['a.txt', 'b.txt'],
      'oldest first'
    );
    assert.equal(waiting.status, 'waiting');

    session.respond('req-a', { allow: true });
    const after = await until(session, 'the response echo', (s) => s.words.includes('RESPONSE'));
    assert.deepEqual(
      after.pending.map((p) => p.requestId),
      ['req-b'],
      'the answer takes its own request and nothing else'
    );
    assert.equal(after.status, 'waiting', 'still blocked on the second');

    const response = echoed(after) as { request_id: string; response: { behavior: string } };
    assert.equal(response.request_id, 'req-a', 'answered by id, not by position');
    assert.equal(response.response.behavior, 'allow');
    assert.equal(
      after.words.split('RESPONSE ').length - 1,
      1,
      'one decision put one response on the wire'
    );

    session.respond('req-b', { allow: false });
    const done = await until(session, 'the turn to end', (s) => s.status === 'idle');
    assert.deepEqual(done.pending, []);
  });

  it('clears both open requests when the interrupt retracts them', async () => {
    const session = start();
    session.send('two writes');
    await until(session, 'both prompts', (s) => s.pending.length === 2);
    await session.interrupt();
    const state = await until(session, 'the turn to end', (s) => s.status === 'idle');
    assert.deepEqual(state.pending, [], 'neither is left offering to allow a dead write');
  });

  /**
   * The blank is the whole of what this guard is for. `{"subtype":"set_model"}`
   * with no `model` answers `success` and silently resets the session to the
   * account's configured default (observed 2.1.220 —
   * `docs/reference/cli_state/claude/protocol.md`), so the failure it prevents is not an
   * error anybody would see: the reader picks nothing and the session quietly
   * moves off the model it was on.
   */
  it('refuses a model change with no model, without writing anything', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    await assert.rejects(session.setModel(''), /needs a model/);
    await assert.rejects(session.setModel('   '), /needs a model/);
    assert.deepEqual(rig.written, [], 'a blank reached the pipe');
  });

  /**
   * The window a session is in is decided at the launch line and cannot move
   * afterwards: `[1m]` is on an id already sent, and the flag came in on
   * `--settings` at spawn. So `set_model` spells the window where it can and
   * refuses where it cannot — a frame that succeeded while the session stayed
   * in its old window would leave the card stating a size it is not in.
   */
  /**
   * The window follows the model on a switch, and nothing is refused for it.
   *
   * Only the `--settings` flag genuinely holds a session, and it holds a
   * *ceiling* rather than a figure; `[1m]` is ours to spell again. What the
   * reader pressed is recorded as `windowAsked` either way, so where the
   * account gives something else the card's existing mark is the warning.
   */
  describe('a model change and the window it asks for', () => {
    const on = (model: string, window?: number, windowReach?: 'plain' | 'suffix' | 'flag') => {
      const rig = stub();
      const session = new claude.OwnedSession(rig.transport, {
        cwd: nowhere,
        startedAt: 1000,
        model,
        window,
        windowReach
      });
      return { rig, session };
    };
    const sent = (rig: ReturnType<typeof stub>): unknown =>
      (control(rig.written, 'set_model')?.request as Record<string, unknown> | undefined)?.model;
    /** The same round trip from the other end. `control` takes the *first*
     *  match, so a case that switches twice must answer the later one. */
    const latest = (rig: ReturnType<typeof stub>): Outbound | undefined =>
      rig.written
        .filter(
          (frame) =>
            frame.type === 'control_request' &&
            (frame.request as { subtype?: unknown } | undefined)?.subtype === 'set_model'
        )
        .at(-1);

    it('spells the suffix where the window asked for is reached that way', async () => {
      const { rig, session } = on('claude-opus-5', 1_000_000, 'suffix');
      const asked = session.setModel('claude-opus-4-8', 1_000_000);
      // Composed here, and stored nowhere: the catalog carries the raw id.
      assert.equal(sent(rig), 'claude-opus-4-8[1m]');
      const request = latest(rig);
      rig.answer(answeredOk(request?.request_id as string, {}));
      await asked;
    });

    it('sends a bare id where the target reaches that window plain', async () => {
      const { rig, session } = on('claude-opus-5', 1_000_000, 'suffix');
      const asked = session.setModel('claude-sonnet-5', 1_000_000);
      assert.equal(sent(rig), 'claude-sonnet-5');
      const request = latest(rig);
      rig.answer(answeredOk(request?.request_id as string, {}));
      await asked;
    });

    /**
     * The case the whole rule was rewritten for. Haiku 4.5 has no 1M window, so
     * an earlier draft refused this outright — which, with the gear defaulting
     * to the widest row, meant the cheap model was unreachable from most
     * sessions. It goes through now; the window follows.
     */
    it('takes a target with no such window, and follows it there', async () => {
      const { rig, session } = on('claude-opus-5', 1_000_000, 'suffix');
      const asked = session.setModel('claude-haiku-4-5', 200_000);
      const request = control(rig.written, 'set_model');
      assert.equal((request?.request as Record<string, unknown>).model, 'claude-haiku-4-5');
      rig.answer(answeredOk(request?.request_id as string, {}));
      await asked;
      assert.equal(session.state.windowAsked, 200_000, 'the window did not follow');
      // Whatever the old session had been told is no longer a statement about
      // this model, so it is dropped rather than left to draw a stale figure.
      assert.equal(session.state.windowStated, undefined);
    });

    /** The flag is on the line for the *session*, not the id, so it still holds
     *  after a switch. The bare id is what reaches a `flag` window: there is no
     *  spelling for one, and the line already carries it. */
    it('keeps the flag’s window when the target reaches it that way', async () => {
      const { rig, session } = on('claude-opus-5', 200_000, 'flag');
      const asked = session.setModel('claude-opus-4-8', 200_000);
      const request = control(rig.written, 'set_model');
      assert.equal((request?.request as Record<string, unknown>).model, 'claude-opus-4-8');
      rig.answer(answeredOk(request?.request_id as string, {}));
      await asked;
      assert.equal(session.state.windowAsked, 200_000);
    });

    /** No flag on the line and none can be added, so the window asked for is
     *  recorded and left for the wire to confirm or contradict. That gap is
     *  what the card's mark is for. */
    it('asks for a flag window it cannot spell, and records the ask', async () => {
      const { rig, session } = on('claude-haiku-4-5', 200_000, 'plain');
      const asked = session.setModel('claude-opus-5', 200_000);
      const request = control(rig.written, 'set_model');
      assert.equal((request?.request as Record<string, unknown>).model, 'claude-opus-5');
      rig.answer(answeredOk(request?.request_id as string, {}));
      await asked;
      assert.equal(session.state.windowAsked, 200_000);
    });

    it('keeps the session’s own window when the menu sends none', async () => {
      // A menu built before this shipped, and every `/model` typed elsewhere.
      const { rig, session } = on('claude-opus-5', 1_000_000, 'suffix');
      const asked = session.setModel('claude-opus-4-8');
      assert.equal(sent(rig), 'claude-opus-4-8[1m]');
      const request = latest(rig);
      rig.answer(answeredOk(request?.request_id as string, {}));
      await asked;
    });

    /**
     * The bug the rename closes. `setModel` used to write this field on every
     * switch, from the *target*'s row — so a flagged line that switched onto a
     * `plain` window recorded `plain`, and every reader keyed on "does this line
     * carry the flag" was then wrong. It is the launch line's, written once.
     */
    it('leaves the launch line’s reach alone, however many switches run', async () => {
      const { rig, session } = on('claude-opus-5', 200_000, 'flag');
      assert.equal(session.state.launchReach, 'flag');
      for (const [model, window] of [
        ['claude-sonnet-5', 1_000_000],
        ['claude-opus-5', 200_000]
      ] as const) {
        const asked = session.setModel(model, window);
        rig.answer(answeredOk(latest(rig)?.request_id as string, {}));
        await asked;
        assert.equal(session.state.launchReach, 'flag', `moved by the switch to ${model}`);
      }
    });

    /**
     * The flag outranks the suffix, so spelling `[1m]` on a flagged line is a
     * lie the wire will not honour: probed 2026-08-29 on 2.1.241, a flagged
     * `claude-opus-5[1m]` comes back stating 200,000. The bare id is what this
     * line can actually reach, and it is what gets sent.
     *
     * The outcome is the same either way — the flag holds it down whichever
     * spelling goes out — so this is the honest send rather than a fix to what
     * the session runs at. What *changes* is that one function now answers
     * "can this line reach that window" for the composer's menu and for the
     * send alike, so the two cannot drift.
     */
    it('does not spell a suffix the line’s flag would override', async () => {
      const { rig, session } = on('claude-opus-5', 200_000, 'flag');
      const asked = session.setModel('claude-opus-4-8', 1_000_000);
      assert.equal(sent(rig), 'claude-opus-4-8');
      const request = latest(rig);
      rig.answer(answeredOk(request?.request_id as string, {}));
      await asked;
    });

    it('sends the id plain when the session has no window', async () => {
      const { rig, session } = on('claude-opus-5');
      const asked = session.setModel('claude-opus-4-8');
      assert.equal(sent(rig), 'claude-opus-4-8');
      const request = latest(rig);
      rig.answer(answeredOk(request?.request_id as string, {}));
      await asked;
    });

    it('keeps the raw id as the pick, not the spelling it sent', async () => {
      const { rig, session } = on('claude-opus-5', 1_000_000, 'suffix');
      const asked = session.setModel('claude-opus-4-8', 1_000_000);
      const request = control(rig.written, 'set_model');
      rig.answer(answeredOk(request?.request_id as string, {}));
      await asked;
      // `windowOf` needs the raw id to find the row again.
      assert.equal(session.state.modelPick, 'claude-opus-4-8');
    });
  });

  it('sends a model change as one control request', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    const asked = session.setModel('haiku');

    const request = control(rig.written, 'set_model');
    assert.ok(request, 'nothing went out');
    // The CLI's own spelling, which is what the reference records: the subtype
    // and the field are both its words, and a rename upstream lands here.
    assert.equal((request.request as Record<string, unknown>).subtype, 'set_model');
    assert.equal((request.request as Record<string, unknown>).model, 'haiku');
    assert.equal(rig.written.length, 1, 'a model change is not also a turn');

    rig.answer(answeredOk(request.request_id as string, {}));
    await asked;
    // What the reader picked, kept: nothing on the wire will restate this
    // alias — the CLI answers `init` in its own spelling on the next turn — and
    // it is the only spelling a menu row carries.
    assert.equal(session.state.modelPick, 'haiku');
    assert.equal(session.state.model, undefined, 'a pick is not a reading');
  });

  it('applies a send target before the prompt, in the CLI’s native order', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, {
      cwd: nowhere,
      startedAt: 1000,
      model: 'claude-opus-5',
      window: 200_000,
      windowReach: 'suffix'
    });

    session.send('do the work', [], undefined, false, {
      model: 'claude-sonnet-5',
      window: 1_000_000,
      effort: 'high'
    });
    const request = await waitForControl(rig.written, 'set_model');
    assert.equal((request.request as Record<string, unknown>).model, 'claude-sonnet-5');
    assert.equal(rig.written.filter((frame) => frame.type === 'user').length, 0);

    rig.answer(answeredOk(request.request_id as string, {}));
    assert.equal(session.state.queued[0]?.text, '/effort high');
    assert.equal(session.state.queued[0]?.command, true);
    assert.equal(session.state.queued[1]?.text, 'do the work');
    assert.equal(session.state.queued[0]?.id, session.state.queued[1]?.id);

    await outbox(session, 1);
    let turns = rig.written.filter((frame) => frame.type === 'user');
    assert.equal(turns.length, 1);
    assert.match(JSON.stringify(turns[0]), /\/effort high/);
    assert.ok(!JSON.stringify(turns[0]).includes('do the work'), 'the command was merged');

    rig.answer(turnStarted('claude-sonnet-5'));
    rig.answer({ type: 'result' });
    await outbox(session, 0);
    turns = rig.written.filter((frame) => frame.type === 'user');
    assert.equal(turns.length, 2);
    assert.match(JSON.stringify(turns[1]), /do the work/);
  });

  it('applies each queued model only when its prompt reaches the head', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    rig.answer(turnStarted('claude-opus-5'));

    session.send('first', [], undefined, false, { model: 'claude-sonnet-5' });
    session.send('second', [], undefined, false, { model: 'claude-opus-5' });
    assert.equal(control(rig.written, 'set_model'), undefined);

    rig.answer({ type: 'result' });
    const first = await waitForControl(rig.written, 'set_model');
    assert.equal((first.request as Record<string, unknown>).model, 'claude-sonnet-5');
    rig.answer(answeredOk(first.request_id as string, {}));
    await outbox(session, 1);

    rig.answer(turnStarted('claude-sonnet-5'));
    rig.answer({ type: 'result' });
    const second = await waitForControl(rig.written, 'set_model', 1);
    assert.equal((second.request as Record<string, unknown>).model, 'claude-opus-5');
  });

  it('keeps a targeted act ahead once its model control has started', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    session.send('targeted', [], undefined, false, { model: 'claude-sonnet-5' });
    const request = await waitForControl(rig.written, 'set_model');

    session.send('urgent', [], undefined, true);
    rig.answer(answeredOk(request.request_id as string, {}));
    await outbox(session, 1);
    const first = rig.written.find((frame) => frame.type === 'user');
    assert.match(JSON.stringify(first), /targeted/);
    assert.ok(!JSON.stringify(first).includes('urgent'));
  });

  it('keeps a targeted act ahead after its effort command has started', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    session.send('targeted', [], undefined, false, {
      model: 'claude-sonnet-5',
      effort: 'high'
    });
    const request = await waitForControl(rig.written, 'set_model');
    rig.answer(answeredOk(request.request_id as string, {}));
    await outbox(session, 1);

    session.send('urgent', [], undefined, true);
    assert.equal(session.state.queued[0]?.text, 'targeted');
    rig.answer(turnStarted('claude-sonnet-5'));
    rig.answer({ type: 'result' });
    await outbox(session, 1);
    const turns = rig.written.filter((frame) => frame.type === 'user');
    assert.match(JSON.stringify(turns[1]), /targeted/);
    assert.ok(!JSON.stringify(turns[1]).includes('urgent'));
  });

  it('keeps a targeted send the CLI refused, and still drains later messages', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    rig.answer(turnStarted('claude-opus-5'));
    session.send('first', [], undefined, false, { model: 'claude-sonnet-5' });
    session.send('second');
    rig.answer({ type: 'result' });
    const request = await waitForControl(rig.written, 'set_model');
    rig.answer(answeredError(request.request_id as string, 'no'));
    await outbox(session, 1);
    assert.equal(session.state.queued[0]?.text, 'first');
    const turns = rig.written.filter((frame) => frame.type === 'user');
    assert.equal(turns.length, 1);
    assert.match(JSON.stringify(turns[0]), /second/);
    assert.ok(!JSON.stringify(turns[0]).includes('first'));
    assert.equal(session.dismiss(session.state.queued[0]?.id ?? ''), true);
    assert.deepEqual(session.state.queued, []);
  });

  it('dismisses a targeted effort command and its prompt as one act', () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    rig.answer(turnStarted('claude-opus-5'));
    session.send('do the work', [], undefined, false, { effort: 'high' });
    assert.equal(session.state.queued.length, 2);

    assert.equal(session.dismiss(session.state.queued[1]?.id ?? ''), true);
    assert.deepEqual(session.state.queued, []);
  });

  it('keeps a prompt once its effort command has started', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    rig.answer(turnStarted('claude-opus-5'));
    session.send('do the work', [], undefined, false, { effort: 'high' });
    const id = session.state.queued[0]?.id ?? '';

    rig.answer({ type: 'result' });
    await outbox(session, 1);
    assert.equal(session.dismiss(id), false);
    assert.equal(session.state.queued[0]?.text, 'do the work');
  });

  it('keeps the model it was started on until a switch is taken', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, {
      cwd: nowhere,
      startedAt: 1000,
      model: 'opus[1m]'
    });
    assert.equal(session.state.modelPick, 'opus[1m]');
    // A refused switch leaves it where it was: the session goes on running the
    // model it was started on, and the pill must go on saying so.
    const asked = session.setModel('haiku');
    const request = control(rig.written, 'set_model');
    assert.ok(request, 'nothing went out');
    rig.answer(answeredError(request.request_id as string, 'no'));
    await assert.rejects(asked);
    assert.equal(session.state.modelPick, 'opus[1m]');
  });

  it('states the effort it was started on before any turn runs', () => {
    // Nothing on this CLI's pipe restates an effort, and the transcript only
    // does from the first assistant entry — so without the launch line's own
    // answer the composer read no effort for the first turns.
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, {
      cwd: nowhere,
      startedAt: 1000,
      effort: 'high'
    });
    assert.equal(session.state.effort, 'high');
  });

  it('drops a response to a request that is no longer open', async () => {
    // The gap is real: an interrupt retracts an open request about a
    // millisecond after it is asked for, so a pick staged on a card that has
    // just been cancelled must not be posted into nothing.
    const session = start();
    session.send('write a file');
    await until(session, 'the permission prompt', (s) => s.pending.length > 0);
    // And says so, because one caller is a window away: a drop reported as a
    // success is how a reader comes to believe they allowed a call that nothing
    // ever allowed.
    assert.equal(session.respond('nobody-asked', { allow: true }), false);
    assert.equal(session.respond('nobody-asked', { allow: false }), false);
    assert.equal(session.state.pending.length, 1, 'the real request is untouched');

    const open = session.state.pending[0]?.requestId ?? '';
    assert.equal(session.respond(open, { allow: true }), true, 'the one that was open');
  });

  it('drains an idle send and holds while busy', async () => {
    const session = start();
    session.send('slow work');
    // Idle: the drain takes it, one baseline later, so the outbox empties and
    // the turn goes on the pipe. `slow` never ends on its own (fake-cli).
    await outbox(session, 0);
    await until(session, 'the turn to start', (s) => s.status === 'busy');
    session.send('held while busy');
    assert.equal(session.state.queued.length, 1);
    assert.equal(session.state.queued[0]?.text, 'held while busy');
  });

  it('sendNow interrupts and sends every held message', async () => {
    // The same claim as the stub test below, against a real child over the real
    // transport: the interrupt is answered by a `claude` process and the outbox
    // empties on the turn that ends. The stub is what can pin the frame ordering
    // and count the writes; this is what proves the sequence survives a pipe.
    const session = start();
    session.send('slow work');
    await until(session, 'the turn to start', (s) => s.status === 'busy');
    session.send('first held');
    session.send('second held');
    assert.equal(session.state.queued.length, 2);
    await session.sendNow();
    // Interrupt ends the slow turn; the merged entry goes on the idle after it.
    await until(session, 'outbox empty', (s) => s.queued.length === 0);
  });

  it('sends the held messages as one turn, not one per idle edge', async () => {
    // The bar offers to send all N. N turns is not that: the session would act
    // on the first before it had read the rest.
    //
    // Frame order here is the hostile one, and the reason the drain is held shut
    // across the interrupt rather than the outbox being merged on both sides of
    // it: the response and the `result` arrive together — one stdout chunk, as
    // they do when the CLI tears the turn down as it answers — so the idle edge
    // lands before this `await` resumes. An unguarded drain writes the head
    // alone there and the rest goes as a second turn.
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    rig.answer(turnStarted('claude-opus-5'));
    session.send('first held');
    session.send('second held');
    assert.equal(session.state.queued.length, 2, 'both held while busy');

    const sendNow = session.sendNow();
    const request = control(rig.written, 'interrupt');
    const requestId = request?.request_id;
    assert.equal(typeof requestId, 'string', 'the interrupt went out');
    rig.answer(answeredOk(requestId as string));
    // And typed while the turn was ending: it is held too, and goes with them.
    session.send('third, typed during the interrupt');
    rig.answer({ type: 'result' });
    await sendNow;
    await outbox(session, 0);

    const sends = rig.written.filter((frame) => frame.type === 'user');
    assert.equal(sends.length, 1, 'one write, not one per message');
    assert.deepEqual(sends[0]?.message, {
      role: 'user',
      content: [
        { type: 'text', text: 'first held\n\n' },
        { type: 'text', text: 'second held\n\n' },
        { type: 'text', text: 'third, typed during the interrupt' }
      ]
    });
    assert.deepEqual(session.state.queued, [], 'and the outbox is empty');
  });

  it('drains the whole outbox as one turn, with nobody pressing anything', async () => {
    // The idle edge, not send-now: three rows held while a turn ran go together
    // when it ends, the way the CLI's own TUI flushes its queue. One per idle
    // would have the session answer the first having read none of the rest.
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    rig.answer(turnStarted('claude-opus-5'));
    session.send('first held');
    session.send('second held');
    session.send('third held');
    assert.equal(session.state.queued.length, 3, 'all three held while busy');
    assert.equal(rig.written.filter((frame) => frame.type === 'user').length, 0, 'nothing yet');

    rig.answer({ type: 'result' });
    await outbox(session, 0);

    const sends = rig.written.filter((frame) => frame.type === 'user');
    assert.equal(sends.length, 1, 'one write on the idle edge');
    assert.deepEqual(sends[0]?.message, {
      role: 'user',
      content: [
        { type: 'text', text: 'first held\n\n' },
        { type: 'text', text: 'second held\n\n' },
        { type: 'text', text: 'third held' }
      ]
    });
    assert.deepEqual(session.state.queued, [], 'and the outbox is empty');
  });

  it('dismiss drops one held message by id', async () => {
    const session = start();
    session.send('slow work');
    await until(session, 'the turn to start', (s) => s.status === 'busy');
    session.send('keep me');
    session.send('drop me');
    const drop = session.state.queued.find((e) => e.text === 'drop me');
    assert.ok(drop);
    assert.equal(session.dismiss(drop.id), true);
    assert.deepEqual(
      session.state.queued.map((e) => e.text),
      ['keep me']
    );
  });

  it('says no when the id it was asked to dismiss is no longer held', async () => {
    // What another window's Dismiss lands on. Its record is a publish and a poll
    // old, so the row it clicked may have drained — and answering `ok` there
    // would tell that reader they cancelled a message that is running.
    const session = start();
    session.send('slow work');
    await until(session, 'the turn to start', (s) => s.status === 'busy');
    session.send('drop me');
    const held = session.state.queued[0];
    assert.ok(held);
    assert.equal(session.dismiss(held.id), true);
    assert.equal(session.dismiss(held.id), false);
    assert.equal(session.dismiss('never-queued'), false);
  });

  it('clears an open request when the interrupt retracts it', async () => {
    const session = start();
    session.send('write a file');
    await until(session, 'the permission prompt', (s) => s.pending.length > 0);
    await session.interrupt();
    const state = await until(session, 'the turn to end', (s) => s.status === 'idle');
    // Nothing answered it: the cancel is what took it off the list, which is
    // the only reason the card is not still offering to allow a write that no
    // longer has anything waiting on it.
    assert.deepEqual(state.pending, []);
  });

  /**
   * The cadence is not this session's. A round trip per turn end, per session,
   * is a fleet of them asking about one account — so the panel holds one clock
   * per brand and asks whichever session it has (`core/usage.ts`,
   * `SessionHandle.usage`). What is left here is the capability and no clock.
   */
  it('asks for nothing of its own when a turn ends, and answers when asked', async (t) => {
    let now = 1_700_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    const asks = () =>
      rig.written.filter(
        (frame) =>
          frame.type === 'control_request' &&
          (frame.request as { subtype?: unknown } | undefined)?.subtype === 'get_usage'
      ).length;

    rig.answer(turnStarted('claude-opus-5'));
    rig.answer({ type: 'result' });
    assert.equal(asks(), 0, 'a turn ending spent a round trip of its own');

    // The host's ask, on its own clock. Measured to answer mid-turn as well as
    // at rest (`reference/cli_state/claude/protocol.md`), which is what lets
    // that clock be a timer rather than an edge.
    const answered = session.usage?.read();
    const requestId = control(rig.written, 'get_usage')?.request_id;
    assert.equal(typeof requestId, 'string', 'the capability sent nothing');
    now += 1000;
    rig.answer(answeredOk(requestId as string, { rate_limits: { five_hour: { utilization: 3 } } }));
    const reading = await answered;
    assert.equal(win(reading, 'session')?.pct, 3);
    assert.equal(reading?.at, now);
    assert.deepEqual(
      reading?.windows.map((window) => window.at),
      [now, now]
    );
    session.close();
  });

  /**
   * 2.1.309's `rate_limit_event` carries both windows' quota, and it answers an
   * API response of this process — a genuine observation, stamped on arrival.
   * A `result` beside it carries tokens and cost, which are not quota.
   */
  it('takes a rate_limit_event’s windows as a reading stamped at receipt', (t) => {
    let now = 1_700_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    rig.answer(turnStarted('claude-opus-5'));
    rig.answer({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1_700_018_000,
        unifiedWindows: {
          five_hour: { utilization: 0.2, resetsAt: 1_700_018_000 },
          seven_day: { utilization: 0.71, resetsAt: 1_700_500_000 }
        }
      }
    });
    assert.equal(win(session.state.usage, 'session')?.pct, 20);
    assert.equal(win(session.state.usage, 'weekly')?.pct, 71);
    assert.equal(session.state.usage?.at, now);
    now += 5_000;
    rig.answer({
      type: 'result',
      total_cost_usd: 0.1,
      usage: { input_tokens: 10, output_tokens: 4 }
    });
    assert.equal(session.state.usage?.at, now - 5_000, 'a result restamped the quota');
    session.close();
  });

  it('keeps every window two partial pushes observed, each with its own stamp', (t) => {
    let now = 1_700_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    const event = (windows: Record<string, unknown>) => ({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', unifiedWindows: windows }
    });
    rig.answer(event({ five_hour: { utilization: 0.2, resetsAt: 1_700_018_000 } }));
    now += 1_000;
    rig.answer(event({ seven_day: { utilization: 0.71, resetsAt: 1_700_500_000 } }));
    assert.equal(win(session.state.usage, 'session')?.pct, 20);
    assert.equal(win(session.state.usage, 'session')?.at, now - 1_000);
    assert.equal(win(session.state.usage, 'weekly')?.pct, 71);
    assert.equal(win(session.state.usage, 'weekly')?.at, now);
    session.close();
  });

  it('gives up an unanswered usage round trip when its read is cancelled', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    const controller = new AbortController();
    const read = session.usage?.read(controller.signal);
    assert.ok(control(rig.written, 'get_usage'), 'the round trip went out');
    controller.abort();
    const settled = await Promise.race([
      read?.then(
        () => 'answered',
        () => 'refused'
      ),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200))
    ]);
    assert.equal(settled, 'refused', 'a cancelled read kept waiting on the pipe');
    session.close();
  });

  it('keeps a pushed figure a later partial round trip has none for', async (t) => {
    const now = 1_700_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    rig.answer({
      type: 'rate_limit_event',
      rate_limit_info: {
        unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1_700_018_000 } }
      }
    });
    const asked = session.refreshUsage();
    const id = control(rig.written, 'get_usage')?.request_id;
    rig.answer(
      answeredOk(id as string, {
        rate_limits: { seven_day: { utilization: 71, resets_at: '2023-11-21T00:00:00Z' } }
      })
    );
    await asked;
    assert.equal(win(session.state.usage, 'session')?.pct, 20, 'a figureless window replaced it');
    assert.equal(win(session.state.usage, 'weekly')?.pct, 71);
    session.close();
  });

  it('reads the plan’s usage off a round trip, not off a frame', async () => {
    const session = start();
    await session.refreshUsage();
    assert.equal(win(session.state.usage, 'session')?.pct, 3);
    assert.equal(win(session.state.usage, 'weekly')?.pct, 47);
  });

  /**
   * A round trip that answered nothing readable must say so, rather than hand
   * back the reading before it as though this trip had produced one. The caller
   * (`panel_auth.ts`'s `askSession`) reads `undefined` as "go and look
   * somewhere else", and it cannot make that call on an answer it is told is
   * fresh.
   */
  it('answers nothing when the round trip carried no reading', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });

    const first = session.refreshUsage();
    const one = control(rig.written, 'get_usage')?.request_id;
    rig.answer(answeredOk(one as string, { rate_limits: { five_hour: { utilization: 3 } } }));
    assert.equal(win(await first, 'session')?.pct, 3);

    const again = session.refreshUsage();
    const two = rig.written
      .filter((frame) => frame.type === 'control_request')
      .map(
        (frame) => (frame.request as { subtype?: unknown } | undefined)?.subtype === 'get_usage'
      ).length;
    assert.ok(two >= 1, 'the second round trip went out');
    const id = control(rig.written.slice().reverse(), 'get_usage')?.request_id;
    rig.answer(answeredOk(id as string, { rate_limits: null }));
    assert.equal(await again, undefined, 'a bad answer was reported as an answer');
    // And the session still holds the good one, for the card it draws.
    assert.equal(win(session.state.usage, 'session')?.pct, 3);
    session.close();
  });

  it('does not put a drained message back when a round trip answers', async () => {
    // The loop this cost us: `get_usage` is asked for on the same idle edge the
    // drain writes on, and its answer was applied to the state read *before*
    // the round trip. That state still held the message the drain had just
    // written, so it came back to the outbox and was written again on the next
    // idle edge — the same prompt to the CLI, once per turn, forever.
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    // A turn running, and a message held behind it.
    rig.answer(turnStarted('claude-opus-5'));
    assert.equal(session.state.running, true);
    session.send('do the thing');
    assert.equal(session.state.queued.length, 1, 'held while busy');

    // The turn's end, which is where the panel asks for usage *and* where the
    // drain writes — the two racing on the same edge is the whole bug.
    const asked = session.refreshUsage();
    rig.answer({ type: 'result' });
    await outbox(session, 0);
    assert.deepEqual(session.state.queued, [], 'the drain wrote it and popped it');

    const request = control(rig.written, 'get_usage');
    const requestId = request?.request_id;
    assert.equal(typeof requestId, 'string', 'the usage round trip went out');
    rig.answer(answeredOk(requestId as string, { rate_limits: { five_hour: { utilization: 3 } } }));
    await asked;

    assert.equal(win(session.state.usage, 'session')?.pct, 3, 'the answer landed');
    assert.deepEqual(session.state.queued, [], 'and took nothing back with it');
    const sends = rig.written.filter((frame) => frame.type === 'user');
    assert.equal(sends.length, 1, 'written once');
  });

  it('advances the activity clock for a prompt and latched agent activity', () => {
    assert.equal(
      adapter.advancesActivityClock({
        origin: 'agent',
        status: 'idle',
        turned: false,
        warm: false
      }),
      false,
      'resume roster noise passed the pre-turn latch'
    );
    assert.equal(
      adapter.advancesActivityClock({
        origin: 'prompt',
        status: 'idle',
        turned: false,
        warm: false
      }),
      true,
      'a prompt did not arm and refresh the session'
    );
    assert.equal(
      adapter.advancesActivityClock({ origin: 'agent', status: 'idle', turned: true, warm: false }),
      true,
      'a completed turn did not refresh the session'
    );
    assert.equal(
      adapter.advancesActivityClock({ origin: 'local', status: 'busy', turned: true, warm: false }),
      false,
      'panel bookkeeping refreshed the session'
    );
  });

  it('tells the session speaking apart from the panel writing its own record', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    const origins: string[] = [];
    session.onChange((_state, origin) => {
      origins.push(origin);
    });

    rig.answer(turnStarted('claude-opus-5'));
    assert.ok(origins.includes('agent'), 'a frame the child pushed is the session acting');

    // The round trip that was moving it. An answer about the *account* is news
    // to the usage chip and to nothing else — the session did not run for it,
    // and its prompt cache is no warmer than it was.
    origins.length = 0;
    const asked = session.refreshUsage();
    const requestId = control(rig.written, 'get_usage')?.request_id;
    rig.answer(answeredOk(requestId as string, { rate_limits: { five_hour: { utilization: 3 } } }));
    await asked;
    assert.equal(win(session.state.usage, 'session')?.pct, 3, 'the reading still landed');
    assert.deepEqual(origins, ['local'], 'a usage answer is not the session acting');

    // The rest of what this window writes into its own record of a session.
    origins.length = 0;
    session.send('held');
    session.dismiss(session.state.queued[0]?.id ?? '');
    const picked = session.setModel('claude-haiku-4-5');
    const pick = control(rig.written, 'set_model');
    rig.answer(answeredOk(pick?.request_id as string, {}));
    await picked;
    assert.ok(origins.length > 0, 'nothing was applied at all');
    assert.ok(
      !origins.includes('agent'),
      'a queue edit or a model pick moved the clock the card reads'
    );
    session.close();
  });

  it('marks a Claude prompt as activity but leaves a slash command local', async () => {
    const promptRig = stub();
    const prompt = new claude.OwnedSession(promptRig.transport, { cwd: nowhere, startedAt: 1000 });
    const promptOrigins: string[] = [];
    prompt.onChange((_state, origin) => promptOrigins.push(origin));
    prompt.send('hello');
    await outbox(prompt, 0);
    assert.ok(promptOrigins.includes('prompt'), 'the model prompt was not marked as activity');
    prompt.close();

    const commandRig = stub();
    const command = new claude.OwnedSession(commandRig.transport, {
      cwd: nowhere,
      startedAt: 1000
    });
    const commandOrigins: string[] = [];
    command.onChange((_state, origin) => commandOrigins.push(origin));
    // `/effort` is the command the wall still protects. It drains on its own;
    // the prompt behind it stays queued, because once that prompt drains its
    // origin is `prompt` — the half above.
    command.send('hello', [], undefined, false, { effort: 'high' });
    await outbox(command, 1);
    assert.ok(commandOrigins.length > 0, 'the command changed no state');
    assert.ok(!commandOrigins.includes('prompt'), 'a slash command was marked as a model prompt');
    assert.equal(command.state.queued[0]?.text, 'hello');
    command.close();
  });

  it('send-now frees a drain latch the CLI never acknowledged', async () => {
    // The latch clears when a write is taken — a turn starts, a request opens,
    // the child dies. A write the CLI answers with none of those leaves it set,
    // and every later idle edge returns at the guard: the outbox is shut for the
    // life of the session. Send now is the reader saying *write it anyway*, so
    // it is the one act that drops the latch rather than waiting on it.
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    rig.answer(turnStarted('claude-opus-5'));
    session.send('first');

    // The turn ends: the drain writes `first` and latches. No `init` follows —
    // the CLI took it into the turn it was already tearing down.
    rig.answer({ type: 'result' });
    await outbox(session, 0);
    assert.equal(rig.written.filter((frame) => frame.type === 'user').length, 1);

    // Typed after that write, so it is behind the latch rather than merged into
    // it — the drain empties the outbox, and this is what lands in the next one.
    session.send('second');
    assert.equal(session.state.queued.length, 1, 'second held');

    // Another idle edge changes nothing, because the latch outlived its write.
    rig.answer({ type: 'result' });
    assert.equal(session.state.queued.length, 1, 'wedged: the guard holds it');

    // Nothing is running, so this asks the CLI for no interrupt — it only drops
    // the latch and drains.
    await session.sendNow();
    await outbox(session, 0);
    assert.deepEqual(session.state.queued, [], 'send now got past the guard');
    assert.deepEqual(
      rig.written.filter((frame) => frame.type === 'user').length,
      2,
      'and wrote the message that was stuck'
    );
  });

  it('ends the child by closing its stdin, and says so on the card', async () => {
    // Stdin EOF is the ending the CLI guarantees — the one that also fires when
    // the extension host dies without running any cleanup of its own.
    const session = open();
    session.close();
    const state = await until(session, 'the exit', (s) => s.exit !== undefined);
    assert.equal(state.exit?.code, 0);
    assert.equal(state.status, 'idle');
  });

  it('refuses a binary that is not there, with the reason on it', async () => {
    const session = new claude.OwnedSession(
      pipe.childTransport({ bin: executables.named('/no/such/claude'), cwd: process.cwd() }),
      { cwd: nowhere, startedAt: 1000 }
    );
    const state = await until(session, 'the exit', (s) => s.exit !== undefined);
    assert.equal(state.status, 'idle');
    assert.equal(state.exit?.code, null);
  });

  it('ends a spawn that throws the way it ends one that errors', async () => {
    // A NUL in the file throws synchronously on every platform, standing in for
    // win32's EINVAL on a `.cmd`.
    const transport = pipe.childTransport({
      bin: executables.named('claude\0'),
      cwd: process.cwd()
    });
    assert.equal(transport.pid, undefined);
    assert.equal(transport.processAlive?.(), false);
    const session = new claude.OwnedSession(transport, { cwd: nowhere, startedAt: 1000 });
    const state = await until(session, 'the exit', (s) => s.exit !== undefined);
    assert.equal(state.exit?.code, null);
    const info = await new Promise<{ source: string; stderr?: string }>((resolve) =>
      transport.onExit(resolve)
    );
    assert.equal(info.source, 'spawn');
    assert.match(info.stderr ?? '', /null bytes/);
    assert.equal(await transport.exited, true);
  });

  it('fails a round trip that outlives its child', async () => {
    // Nothing will ever answer it, and a caller left holding a promise that
    // never settles is the hang this whole path exists to stop.
    const session = new claude.OwnedSession(
      pipe.childTransport({ bin: executables.named('/no/such/claude'), cwd: process.cwd() }),
      { cwd: nowhere, startedAt: 1000 }
    );
    await assert.rejects(session.interrupt(), /ENOENT|no such/i);
  });

  it('records the turns of one chunk in the order their lines arrived', async () => {
    // The invariant the ordered thread writer protects, driven from the tick
    // that produces it: the drain that frees the outbox and the frame behind it
    // issue two appends with nothing between them, and `appendFile` orders
    // neither against the other on its own.
    //
    // The held message carries a picture so the race is decided rather than
    // coin-tossed: its exchange cannot be built until the bytes are copied,
    // where the `assistant` line behind it is ready at once. Unqueued, the
    // second one wins every time.
    //
    // The drain is awaited before that second line rather than racing it in the
    // same chunk: a drain now waits on its turn checkpoint's baseline, and a
    // frame arriving inside that window re-opens the turn, so the write would be
    // held to the next idle edge instead. The image copy is what the ordering
    // hangs on and it is still in flight here.
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, {
      cwd: nowhere,
      startedAt: 1000
    });
    alive.push(session);
    rig.answer({ type: 'system', subtype: 'init', session_id: ORDERED });
    session.send('held while the turn runs', [
      { mediaType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }
    ]);
    assert.equal(session.state.queued.length, 1, 'held, so the drain is the idle edge');

    rig.answer({ type: 'result' });
    await outbox(session, 0);
    rig.answer(spoke('the model answering'));

    const exchanges = await recorded(ORDERED, 2);
    assert.deepEqual(
      exchanges.map((e) => ('role' in e ? e.role : 'mark')),
      ['user', 'assistant']
    );
    const [sent] = exchanges;
    assert.equal(sent && 'text' in sent ? sent.text : undefined, 'held while the turn runs');
    assert.equal(
      sent && 'images' in sent ? sent.images?.length : undefined,
      1,
      'and the picture went with it'
    );
  });

  it('records a merged delivery as one turn per message, each under its author', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    alive.push(session);
    rig.answer({ type: 'system', subtype: 'init', session_id: MERGED });
    session.send(wrapMessage('from a peer', 'peer-session'));
    session.send(wrapWait('All 1 finished.'));
    session.send('and mine', [
      { mediaType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }
    ]);
    assert.equal(session.state.queued.length, 3, 'held while the turn runs');

    rig.answer({ type: 'result' });
    await outbox(session, 0);
    rig.answer(spoke('the model answering'));

    const exchanges = await recorded(MERGED, 4);
    assert.deepEqual(
      exchanges.map((e) =>
        'role' in e
          ? [e.role, e.text, e.from, e.images?.length]
          : ['mark', '', undefined, undefined]
      ),
      [
        ['user', 'from a peer', 'peer-session', undefined],
        ['wait', 'All 1 finished.', undefined, undefined],
        ['user', 'and mine', undefined, 1],
        ['assistant', 'the model answering', undefined, undefined]
      ]
    );
  });

  it('records a readout as a local CLI turn, between the frames it fell between', async () => {
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, { cwd: nowhere, startedAt: 1000 });
    alive.push(session);
    rig.answer({ type: 'system', subtype: 'init', session_id: READOUT });
    rig.answer(spoke('before the rename'));
    session.readout('Session renamed to: x');
    rig.answer(spoke('after the rename'));

    const exchanges = await recorded(READOUT, 3);
    assert.deepEqual(
      exchanges.map((e) => ('role' in e ? [e.role, e.local, e.text] : ['mark'])),
      [
        ['assistant', undefined, 'before the rename'],
        ['cli', true, 'Session renamed to: x'],
        ['assistant', undefined, 'after the rename']
      ]
    );
    const [, readout] = exchanges;
    assert.deepEqual(readout && 'blocks' in readout ? readout.blocks : undefined, [
      { text: 'Session renamed to: x' }
    ]);
    assert.equal(session.state.queued.length, 0, 'nothing reached the outbox');
  });

  it('records an interrupt as the break the disk walk would draw', async () => {
    // Step 6: a session driven through an interrupt leaves the same marker
    // `transcript.ts` mints from `[Request interrupted by user]`. The control
    // frame itself is not a turn; the `result` that ends it is.
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, {
      cwd: nowhere,
      startedAt: 1000
    });
    alive.push(session);
    rig.answer({ type: 'system', subtype: 'init', session_id: INTERRUPTED });
    session.send('stop this');
    assert.equal(session.state.queued.length, 1, 'held behind the init turn');
    // The init opened a turn, so the send is still queued. Ending it drains
    // the prompt — awaited, because the drain waits on its baseline and the next
    // frame would otherwise re-open the turn under it. The next opener is the
    // turn we interrupt.
    rig.answer({ type: 'result' });
    await outbox(session, 0);
    rig.answer(turnStarted('claude-opus-5'));

    const interrupting = session.interrupt();
    const request = control(rig.written, 'interrupt');
    assert.ok(request, 'the interrupt went out');
    rig.answer(answeredOk(request.request_id as string));
    rig.answer({ type: 'result', subtype: 'error_during_execution' });
    await interrupting;

    const exchanges = await recorded(INTERRUPTED, 2);
    assert.deepEqual(
      exchanges.map((e) => ('mark' in e ? e.mark : 'role' in e ? e.role : '?')),
      ['user', 'break']
    );
  });

  it('records what a call returned, against the call it answers', async () => {
    // Phase 1 shipped without this: `tool_use` blocks were kept off the record's
    // assistant turns and the `user` frames answering them were dropped, so
    // every call in a record drew with no output where the `.jsonl` had one.
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, {
      cwd: nowhere,
      startedAt: 1000
    });
    alive.push(session);
    rig.answer({ type: 'system', subtype: 'init', session_id: RETURNED });
    rig.answer({
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'msg_ran',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'toolu_ran', name: 'Bash', input: { command: 'ls' } }]
      }
    });
    rig.answer({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_ran', content: 'notes.txt' }]
      }
    });

    const exchanges = await recorded(RETURNED, 1);
    const turn = exchanges[0];
    const block = turn && 'blocks' in turn ? turn.blocks?.[0] : undefined;
    const call = block && 'call' in block ? block.call : undefined;
    // Polled, like `recorded` itself: the result rides a second append.
    for (let look = 0; look < 200 && call?.output === undefined; look++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const settled = (await record.readRecord(RETURNED))?.exchanges[0];
    const done = settled && 'blocks' in settled ? settled.blocks?.[0] : undefined;
    assert.deepEqual(done && 'call' in done ? done.call : undefined, {
      id: 'toolu_ran',
      name: 'Bash',
      input: { command: 'ls' },
      output: 'notes.txt'
    });
    // And the message the call rode in on is witnessed, which is what decides
    // whether this record may be drawn at all.
    assert.deepEqual([...((await record.readRecord(RETURNED))?.firstSeen ?? [])], [['msg_ran', 0]]);
  });

  it('records what an ask was answered with, which is nowhere on the pipe', async () => {
    // Step 4 measured that `toolUseResult` never reaches this wire, so the picks
    // exist in this process and nowhere else. Teed out of `respond()`, beside
    // the request they answer, and filed against the `tool_use` it named.
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, {
      cwd: nowhere,
      startedAt: 1000
    });
    alive.push(session);
    rig.answer({ type: 'system', subtype: 'init', session_id: ANSWERED });
    rig.answer({
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'msg_ask',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: {} }]
      }
    });
    rig.answer({
      type: 'control_request',
      request_id: 'req-ask',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_ask',
        requires_user_interaction: true,
        input: {
          questions: [
            {
              question: 'Which way?',
              header: 'Route',
              options: [{ label: 'Left' }, { label: 'Right' }]
            }
          ]
        }
      }
    });
    assert.equal(session.state.pending[0]?.toolUseId, 'toolu_ask', 'the call the ask rode in on');
    assert.equal(session.respond('req-ask', { allow: true, picks: [[1]] }), true);

    const exchanges = await recorded(ANSWERED, 1);
    const turn = exchanges[0];
    const block = turn && 'blocks' in turn ? turn.blocks?.[0] : undefined;
    for (let look = 0; look < 200; look++) {
      const settled = (await record.readRecord(ANSWERED))?.exchanges[0];
      const done = settled && 'blocks' in settled ? settled.blocks?.[0] : undefined;
      const call = done && 'call' in done ? done.call : undefined;
      if (call?.ask) {
        assert.deepEqual(call.ask.answers, { 'Which way?': 'Right' });
        assert.equal(call.ask.questions.length, 1);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`the ask was never recorded on ${JSON.stringify(block)}`);
  });

  it('files a turn under the conversation it was built in, not the one a later clear opened', async () => {
    // `enqueue` captures `sessionId` when the turn is made. Reading it at the
    // head of the append queue would put this send in AFTER_CLEAR's file,
    // because the image copy is still in flight when the new `init` lands.
    const rig = stub();
    const session = new claude.OwnedSession(rig.transport, {
      cwd: nowhere,
      startedAt: 1000
    });
    alive.push(session);
    rig.answer({ type: 'system', subtype: 'init', session_id: BEFORE_CLEAR });
    session.send('before the clear', [
      { mediaType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }
    ]);
    assert.equal(session.state.queued.length, 1, 'held, so the drain is the idle edge');

    rig.answer({ type: 'result' });
    await outbox(session, 0);
    // The write has gone and its exchange is enqueued; the image copy behind it
    // is what the clear now races.
    rig.answer({ type: 'conversation_reset' });
    rig.answer({ type: 'system', subtype: 'init', session_id: AFTER_CLEAR });

    const exchanges = await recorded(BEFORE_CLEAR, 1);
    const sent = exchanges[0];
    assert.equal(sent && 'text' in sent ? sent.text : undefined, 'before the clear');
    assert.equal(
      await record.readRecord(AFTER_CLEAR),
      undefined,
      "the pre-clear turn must not open the new conversation's file"
    );
  });
});
