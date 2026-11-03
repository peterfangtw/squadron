import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Session } from '../../core/model';
import { initial, LiveState, PendingRequest } from '../../core/live';
import { WARM_PROMPT, wrapMessage, wrapWait, wrapWarm } from '../../core/coordination/send';
import { composeThread, toThread } from '../../ui/views';
import { session } from '../views_helpers';

describe('toThread', () => {
  // Owned by default, because the composer is: a session in a shell takes no
  // input from here at all, and every question below about *when* sending is
  // offered is a question about a session on a pipe.
  const thread = (over: Partial<Session>, reachable = true): ThreadView =>
    toThread(session({ source: 'owned', ...over }), { reachable, exchanges: [] });

  it('takes no input for a session nothing here can reach, whatever its status', () => {
    // The rule, at the layer that decides it. Reading is untouched — the turns,
    // the branch, the context — and the reason names the window rather than a
    // shell: what lands here is a session another window drives whose record
    // did not arrive, and there is nowhere else for the reader to go.
    for (const status of ['idle', 'busy', 'waiting'] as const) {
      const view = toThread(session({ status }), {
        reachable: false,
        exchanges: []
      });
      assert.equal(view.canSend, false, status);
      assert.match(view.blockedReason ?? '', /nothing here can reach it/, status);
    }
  });

  it('offers the composer to a reachable session at its prompt', () => {
    for (const status of ['idle', 'busy'] as const) {
      const view = thread({ status });
      assert.equal(view.canSend, true, status);
      assert.equal(view.blockedReason, undefined, status);
    }
  });

  it('flattens attach and who from the session, not a brand check in the dock', () => {
    const claude = thread({ brand: 'claude' });
    assert.equal(claude.canSend, true);
    assert.equal(claude.canAttach, true);
    assert.equal(claude.who, 'Claude');
    const grok = thread({ brand: 'grok', images: true });
    assert.equal(grok.canSend, true);
    assert.equal(grok.canAttach, true);
    assert.equal(grok.who, 'Grok');
    assert.equal(thread({ brand: 'grok', images: false }).canAttach, false);
    assert.equal(thread({}).who, 'Claude');
  });

  it('offers the composer while waiting — the outbox holds until the dialog is answered', () => {
    const view = thread({ status: 'waiting' });
    assert.equal(view.canSend, true);
    assert.equal(view.blockedReason, undefined);
  });

  it('offers it to a session running a command — its prompt is still free', () => {
    assert.equal(thread({ status: 'busy', hasCommand: true }).canSend, true);
  });

  it('offers it to a status it cannot read — the pipe decides, not the word', () => {
    // A print-mode session writes no status at all, so the twin's answer is
    // `unknown` by construction. Gating on the word refused those sends and had
    // no reason to give for it; under a held outbox every status the composer
    // can reach holds a message anyway, so reachability is the whole rule.
    const view = thread({ status: 'unknown' });
    assert.equal(view.canSend, true);
    assert.equal(view.blockedReason, undefined);
  });

  it('explains the missing background pipe in neutral words, reachable or not', () => {
    const view = thread({ background: true, status: 'idle' });
    assert.equal(view.canSend, false);
    assert.equal(view.blockedReason, 'Background session — it has no controllable pipe.');
    assert.equal(
      thread({ background: true, status: 'idle' }, false).blockedReason,
      view.blockedReason
    );
  });

  it('keeps card controls and sendability separate for invalid, exited and closing owned sessions', () => {
    const invalid = toThread(
      session({ source: 'owned', control: { canControl: false, reason: 'invalid' } }),
      { reachable: true, exchanges: [] }
    );
    const exited = toThread(session({ source: 'owned' }), {
      reachable: true,
      exited: true,
      exchanges: []
    });
    const closing = thread({ closing: true });
    for (const view of [invalid, exited, closing]) {
      assert.equal(view.canControl, true);
      assert.equal(view.owned, true);
      assert.equal(view.canSend, false);
      assert.equal(view.canAttach, false);
    }
    assert.equal(exited.ended, true);
    assert.equal(invalid.ended, undefined);
    assert.equal(closing.ended, undefined);
  });

  it('says nothing has published a way in when nothing can reach it', () => {
    // It used to say the window had no AgentsView. After row 53 the commoner
    // case is the opposite: a piped session another window drives, whose record
    // failed to write — no claimed shell is a piped session's ancestor, so it
    // carries no `windowId` and lands here from a window that does have the
    // extension.
    const view = thread({ status: 'idle' }, false);
    assert.equal(view.canSend, false);
    assert.match(view.blockedReason ?? '', /No window is publishing a way in/);
  });

  it('does not blame another window for a session of ours that ended', () => {
    // Both are unreachable, and until this was split the dead one was described
    // with the live one's sentence: a reader was told their own session ran
    // somewhere else. It ran right here, and it is over.
    const view = toThread(session({ status: 'unknown', source: 'owned' }), {
      reachable: false,
      exited: true,
      exchanges: []
    });
    assert.equal(view.canSend, false);
    assert.doesNotMatch(view.blockedReason ?? '', /without AgentsView/);
    assert.match(view.blockedReason ?? '', /Ended/);
    // The composer's discriminator, and this is the only view that carries it:
    // a held refusal yields to the reason above for an ended session and holds
    // against the one below.
    assert.equal(view.ended, true);
  });

  it('does not bury an owned session whose window merely stopped publishing', () => {
    // The reading it replaced said "owned and unreachable" meant "ended", which
    // was true while every owned session was local. A session in another window
    // goes out of reach the moment that window stops writing its half down, and
    // it is still running.
    const view = toThread(session({ status: 'busy', source: 'owned' }), {
      reachable: false,
      exited: false,
      exchanges: []
    });
    assert.equal(view.canSend, false);
    assert.doesNotMatch(view.blockedReason ?? '', /Ended/);
    assert.equal(view.ended, undefined);
  });

  it('passes the held outbox through without text-matching the thread', () => {
    // Retire is the drain's job now — the view no longer guesses from transcript.
    const view = toThread(session({ status: 'idle' }), {
      reachable: true,
      exchanges: [
        { role: 'user', text: 'delivered', blocks: [{ prose: 'delivered' }] },
        { role: 'assistant', text: 'ok', blocks: [{ html: '<p>ok</p>' }] }
      ],
      queued: [
        { id: 'a', text: 'delivered' },
        { id: 'b', text: 'still waiting' }
      ]
    });
    assert.deepEqual(view.queued, [
      { id: 'a', text: 'delivered' },
      { id: 'b', text: 'still waiting' }
    ]);
  });

  it('draws an outbox row by its words and its author, never by its envelope', () => {
    // The outbox holds what went on the wire. Drawn straight, a resolution is
    // the reader's own turn with `<squadron-wait>` in the body — observed at
    // the panel, `src/test/live_session/wait_convergence.md`, 2026-08-22. Both
    // wrappers, both lists: `queued` is the same row one beat earlier.
    const view = toThread(session({ status: 'busy' }), {
      reachable: true,
      exchanges: [],
      queued: [
        { id: 'a', text: wrapWait('All 2 of them finished.') },
        { id: 'b', text: wrapMessage('take this one', 'sess-a') },
        { id: 'c', text: 'ship it' }
      ],
      inFlight: { id: 'd', text: wrapWait('All 1 of them finished.'), queuedAt: 5_000 }
    });
    assert.deepEqual(view.queued, [
      { id: 'a', text: 'All 2 of them finished.', role: 'wait' },
      { id: 'b', text: 'take this one', from: 'sess-a' },
      { id: 'c', text: 'ship it' }
    ]);
    assert.deepEqual(view.sending?.[0], {
      id: 'd',
      text: 'All 1 of them finished.',
      images: undefined,
      role: 'wait'
    });
  });

  it('draws no outbox row for a cache-warming ping', () => {
    // Nobody said it; the thread's own warm turn is its only drawing.
    const view = toThread(session({ status: 'idle' }), {
      reachable: true,
      exchanges: [],
      inFlight: { id: 'warm:1', text: wrapWarm(WARM_PROMPT), queuedAt: 5_000, warm: true }
    });
    assert.equal(view.sending, undefined);
  });

  it('retires a resolution against the turn the record filed it as', () => {
    // The echo's whole life is the beat before the record catches up, and for
    // these two the record never says what the outbox holds: the words are
    // unwrapped and a resolution's role is `wait`. Matched raw, the row sat
    // under the turn it woke until the turn ended — the duplicate the panel
    // drew on 2026-08-22.
    const showing = (exchanges: ExchangeView[], text: string) =>
      toThread(session({ status: 'busy' }), {
        reachable: true,
        exchanges,
        inFlight: { id: 'a', text, queuedAt: 5_000 }
      }).sending?.[0];
    const said = 'All 2 sessions you were waiting on have finished.';
    assert.equal(
      showing([{ role: 'wait', text: said, at: 6_000, blocks: [] }], wrapWait(said)),
      undefined
    );
    assert.equal(
      showing(
        [{ role: 'user', text: 'take this one', from: 'sess-a', at: 6_000, blocks: [] }],
        wrapMessage('take this one', 'sess-a')
      ),
      undefined
    );
    // A resolution is not retired by the reader typing the same words, and a
    // typed turn is not retired by a resolution: the author is half the match.
    assert.deepEqual(
      showing([{ role: 'user', text: said, at: 6_000, blocks: [] }], wrapWait(said)),
      { id: 'a', text: said, images: undefined, role: 'wait' }
    );
  });

  it('does not read a slash command out of a wrapped row', () => {
    // `named` settles the echo against a chip, because a slash command lands as
    // one rather than as a turn. A wrapped row can never *be* one — the CLI is
    // handed the envelope and expands nothing inside it — so reading a command
    // out of the body can only ever be a false positive, and chips do not end
    // the walk. Unwrapping `words` and leaving `named` on the wire text is the
    // whole of the difference.
    assert.deepEqual(
      toThread(session({ status: 'busy' }), {
        reachable: true,
        exchanges: [{ mark: 'skill', skill: 'plan', by: 'you' }],
        inFlight: { id: 'a', text: wrapMessage('/plan the migration', 'sess-a'), queuedAt: 5_000 }
      }).sending?.[0],
      { id: 'a', text: '/plan the migration', images: undefined, from: 'sess-a' }
    );
  });

  it('keeps the message it wrote until the transcript says the same words', () => {
    // The drain retires a held row on the write, and the CLI's copy is a poll
    // behind it — so between the two the message is in neither list and the
    // dock showed nothing at all.
    const showing = (exchanges: ExchangeView[]) =>
      toThread(session({ status: 'busy' }), {
        reachable: true,
        exchanges,
        inFlight: { id: 'a', text: 'ship it', queuedAt: 5_000 }
      }).sending?.[0];
    assert.deepEqual(showing([]), { id: 'a', text: 'ship it', images: undefined });
    assert.equal(
      showing([{ role: 'user', text: 'ship it', at: 6_000, blocks: [{ prose: 'ship it' }] }]),
      undefined
    );
    // The attachment path the CLI writes under the words, and the chip a slash
    // command lands as instead of a turn.
    assert.equal(
      showing([{ role: 'user', text: 'ship it\n/tmp/shot.png', at: 6_000, blocks: [] }]),
      undefined
    );
    assert.equal(
      toThread(session({ status: 'busy' }), {
        reachable: true,
        exchanges: [{ mark: 'skill', skill: 'simplify', by: 'you' }],
        inFlight: { id: 'a', text: '/simplify src/app.ts', queuedAt: 5_000 }
      }).sending?.[0],
      undefined
    );
    // Somebody else's words are not this message.
    assert.deepEqual(showing([{ role: 'assistant', text: 'ship it', at: 6_000, blocks: [] }]), {
      id: 'a',
      text: 'ship it',
      images: undefined
    });
  });

  it('draws a merged delivery as one row per message, each retiring on its own turn', () => {
    const parts = [
      { id: 'p', text: wrapMessage('one', 'sess-a') },
      { id: 'q', text: wrapMessage('two', 'sess-b') },
      { id: 'w', text: wrapWait('All 2 finished.') },
      { id: 'a', text: 'mine' }
    ];
    const inFlight = {
      id: 'p+q+w+a',
      text: parts.map((part) => part.text).join('\n\n'),
      queuedAt: 5_000,
      parts
    };
    const showing = (exchanges: ExchangeView[]) =>
      toThread(session({ status: 'busy' }), { reachable: true, exchanges, inFlight }).sending;
    assert.deepEqual(
      showing([])?.map((row) => [row.text, row.from, row.role]),
      [
        ['one', 'sess-a', undefined],
        ['two', 'sess-b', undefined],
        ['All 2 finished.', undefined, 'wait'],
        ['mine', undefined, undefined]
      ]
    );
    const first = [
      { role: 'user' as const, text: 'one', from: 'sess-a', at: 6_000, blocks: [] },
      { role: 'user' as const, text: 'two', from: 'sess-b', at: 6_000, blocks: [] }
    ];
    assert.deepEqual(
      showing(first)?.map((row) => row.text),
      ['All 2 finished.', 'mine']
    );
    assert.equal(
      showing([
        ...first,
        { role: 'wait', text: 'All 2 finished.', at: 6_000, blocks: [] },
        { role: 'user', text: 'mine', at: 6_000, blocks: [] }
      ]),
      undefined,
      'absent once every row has retired, never an empty list'
    );
  });

  it('does not retire the message against an older copy of its own words', () => {
    // Send "continue" twice. Asked of the tail as a whole, the second one
    // matches the first one's turn and retires on the poll it was created —
    // which is the blank gap this whole field exists to fill.
    const again = (exchanges: ExchangeView[]) =>
      toThread(session({ status: 'busy' }), {
        reachable: true,
        exchanges,
        inFlight: { id: 'b', text: 'continue', queuedAt: 5_000 }
      }).sending?.[0];
    assert.deepEqual(
      again([
        { role: 'user', text: 'continue', at: 1_000, blocks: [] },
        { role: 'assistant', text: 'done', at: 2_000, blocks: [] }
      ]),
      {
        id: 'b',
        text: 'continue',
        images: undefined
      }
    );
    // And the same for a slash command sent twice: the chip is matched by name
    // alone, so only the walk's stop keeps the older one out of it.
    assert.deepEqual(
      toThread(session({ status: 'busy' }), {
        reachable: true,
        exchanges: [
          { mark: 'skill', skill: 'model', by: 'you' },
          { role: 'cli', text: 'model set', at: 2_000, local: true, blocks: [] }
        ],
        inFlight: { id: 'b', text: '/model haiku', queuedAt: 5_000 }
      }).sending?.[0],
      { id: 'b', text: '/model haiku', images: undefined }
    );
    // A turn with no stamp at all cannot be dated, so it is read as the tail we
    // are looking at rather than as history — the echo settles on it.
    assert.equal(again([{ role: 'user', text: 'continue', blocks: [] }]), undefined);
  });

  it('retires identical sending words only under their recorded author', () => {
    const parts = [
      { id: 'p', text: wrapMessage('done', 'peer-a') },
      { id: 'q', text: wrapMessage('done', 'peer-b') },
      { id: 'u', text: 'done' }
    ];
    const inFlight = {
      id: 'p+q+u',
      text: parts.map((part) => part.text).join('\n\n'),
      queuedAt: 5_000,
      parts
    };
    const exchanges: ExchangeView[] = [];
    for (const [from, remaining] of [
      ['peer-b', ['p', 'u']],
      ['peer-a', ['u']],
      [undefined, []]
    ] as const) {
      exchanges.push({ role: 'user', text: 'done', from, at: 6_000, blocks: [] });
      const view = toThread(session({ status: 'busy' }), { reachable: true, exchanges, inFlight });
      assert.deepEqual(view.sending?.map((row) => row.id) ?? [], remaining);
    }
  });

  it('keeps Sending for unrelated same-author receipts and same-word prefixes', () => {
    for (const text of ['unrelated', 'done again', 'done-more']) {
      const view = toThread(session({ status: 'busy' }), {
        reachable: true,
        inFlight: { id: 'a', text: wrapMessage('done', 'peer-a'), queuedAt: 5_000 },
        exchanges: [{ role: 'user', text, from: 'peer-a', at: 6_000, blocks: [] }]
      });
      assert.deepEqual(
        view.sending,
        [{ id: 'a', text: 'done', from: 'peer-a', images: undefined }],
        text
      );
    }
  });

  it('settles competing suffix receipts without stranding an exactly recorded part', () => {
    const parts = [
      { id: 'a', text: wrapMessage('done', 'peer-a') },
      { id: 'b', text: wrapMessage('done\nnew', 'peer-a') }
    ];
    const view = toThread(session({ status: 'busy' }), {
      reachable: true,
      inFlight: {
        id: 'a+b',
        text: parts.map((part) => part.text).join('\n\n'),
        queuedAt: 5_000,
        parts
      },
      exchanges: [
        { role: 'user', text: 'done\nold', from: 'peer-a', at: 6_000, blocks: [] },
        { role: 'user', text: 'done\nnew', from: 'peer-a', at: 7_000, blocks: [] }
      ]
    });
    assert.equal(view.sending, undefined);
  });

  it('uses each recorded turn once when the same author repeats a message', () => {
    const view = toThread(session({ status: 'busy' }), {
      reachable: true,
      inFlight: {
        id: 'a+b',
        text: 'continue\n\ncontinue',
        queuedAt: 5_000,
        parts: [
          { id: 'a', text: 'continue' },
          { id: 'b', text: 'continue' }
        ]
      },
      exchanges: [{ role: 'user', text: 'continue', at: 6_000, blocks: [] }]
    });
    assert.deepEqual(
      view.sending?.map((row) => row.id),
      ['b']
    );
  });

  it('matches exact words before claiming a longer message as an attachment suffix', () => {
    const view = toThread(session({ status: 'busy' }), {
      reachable: true,
      inFlight: {
        id: 'a+b',
        text: 'done\n\ndone\nmore',
        queuedAt: 5_000,
        parts: [
          { id: 'a', text: 'done' },
          { id: 'b', text: 'done\nmore' }
        ]
      },
      exchanges: [
        { role: 'user', text: 'done', at: 6_000, blocks: [] },
        { role: 'user', text: 'done\nmore', at: 6_000, blocks: [] }
      ]
    });
    assert.equal(view.sending, undefined);
  });

  it('uses each recorded image-only turn once', () => {
    const view = toThread(session({ status: 'busy' }), {
      reachable: true,
      inFlight: {
        id: 'a+b',
        text: '',
        queuedAt: 5_000,
        parts: [
          { id: 'a', text: '', images: [{ mediaType: 'image/png', data: 'AAA' }] },
          { id: 'b', text: '', images: [{ mediaType: 'image/png', data: 'BBB' }] }
        ]
      },
      exchanges: [
        { role: 'user', text: '', images: [{ id: 'r|first.png' }], at: 6_000, blocks: [] }
      ]
    });
    assert.deepEqual(
      view.sending?.map((row) => row.id),
      ['b']
    );
  });

  it('expands raw merged rows with delivery ids while queued and part ids while sending', () => {
    const parts = [
      {
        id: 'p',
        text: wrapMessage('look', 'peer-a'),
        images: [{ mediaType: 'image/png', data: 'AAA' }]
      },
      {
        id: 'i',
        text: '',
        images: [
          { mediaType: 'image/png', data: 'BBB' },
          { mediaType: 'image/png', data: 'CCC' }
        ]
      },
      { id: 'u', text: 'mine' }
    ];
    const row = { id: 'p+i+u', text: `${parts[0]?.text}\n\nmine`, queuedAt: 5_000, parts };
    const view = toThread(session({ status: 'busy' }), {
      reachable: true,
      exchanges: [],
      queued: [row],
      inFlight: row
    });
    assert.deepEqual(view.queued, [
      { id: 'p+i+u', text: 'look', images: 1, from: 'peer-a' },
      { id: 'p+i+u', text: '', images: 2 },
      { id: 'p+i+u', text: 'mine' }
    ]);
    assert.deepEqual(view.sending, [
      { id: 'p', text: 'look', images: 1, from: 'peer-a' },
      { id: 'i', text: '', images: 2 },
      { id: 'u', text: 'mine', images: undefined }
    ]);
  });

  it('narrows a lone queued image to its count', () => {
    const view = toThread(session({ status: 'busy' }), {
      reachable: true,
      exchanges: [],
      queued: [{ id: 'i', text: '', images: [{ mediaType: 'image/png', data: 'AAA' }] }]
    });
    assert.deepEqual(view.queued, [{ id: 'i', text: '', images: 1 }]);
  });

  it('carries a provenance workflow label onto the thread only', () => {
    const view = toThread(session({ status: 'busy' }), {
      reachable: true,
      exchanges: [],
      workflow: { label: 'plan→build→review', phase: 'running' }
    });
    assert.deepEqual(view.workflow, { label: 'plan→build→review', phase: 'running' });
    // Absent when the host has no active run — and ThreadView-only, never CardView.
    assert.equal(toThread(session({}), { reachable: true, exchanges: [] }).workflow, undefined);
  });

  it('passes through a lean step marker and rail without inventing either', () => {
    const steps = [
      { id: 'plan', label: 'Plan', status: 'completed' as const },
      { id: 'build', label: 'Build', status: 'in_progress' as const, current: true },
      { id: 'review', label: 'Review', status: 'pending' as const }
    ];
    const withStep = toThread(session({ status: 'busy' }), {
      reachable: true,
      exchanges: [],
      workflow: {
        label: 'Ship it',
        phase: 'running',
        step: { label: 'Build', tone: 'working' },
        steps
      }
    });
    assert.deepEqual(withStep.workflow, {
      label: 'Ship it',
      phase: 'running',
      step: { label: 'Build', tone: 'working' },
      steps
    });
    // Coarse only stays coarse — toThread does not fill a step, rail, or phase.
    const coarse = toThread(session({ status: 'busy' }), {
      reachable: true,
      exchanges: [],
      workflow: { label: 'Ship it', phase: 'running' }
    });
    assert.deepEqual(coarse.workflow, { label: 'Ship it', phase: 'running' });
    assert.equal(coarse.workflow?.step, undefined);
    assert.equal(coarse.workflow?.steps, undefined);
  });

  it('carries the card, the turns and the queue through', () => {
    const view = toThread(session({ pid: 42, name: 'titled', status: 'busy' }), {
      reachable: true,
      exchanges: [{ role: 'user', text: 'hi', blocks: [{ prose: 'hi' }] }],
      truncated: true,
      queued: [{ id: 'q1', text: 'next' }]
    });
    assert.equal(view.pid, 42);
    assert.equal(view.name, 'titled');
    assert.equal(view.truncated, true);
    assert.deepEqual(view.queued, [{ id: 'q1', text: 'next' }]);
    assert.equal(view.exchanges.length, 1);
  });

  // ---- the requests an owned session is blocked on ---------------------------
  //
  // The other half of the same field: these arrive on the session's own pipe as
  // `can_use_tool` control requests, so there is no hook, no overlay and no
  // shape to refuse — an ask no keystroke burst could carry is answered here by
  // its request id.

  const request = (over: Partial<PendingRequest> = {}): PendingRequest => ({
    requestId: 'req-1',
    toolName: 'Write',
    ask: false,
    label: 'notes.txt',
    input: { file_path: '/proj/notes.txt', content: 'hi' },
    ...over
  });
  const pendingOf = (...pending: PendingRequest[]): PendingRequestView[] =>
    toThread(session({ status: 'waiting' }), { reachable: true, exchanges: [], pending }).pending ??
    [];

  it('leaves `pending` off a session with no open request', () => {
    assert.equal(thread({ status: 'waiting' }).pending, undefined);
    assert.equal(pendingOf().length, 0);
  });

  it('carries a permission prompt with its label and its input, formatted', () => {
    const [view] = pendingOf(request());
    assert.equal(view?.kind, 'permission');
    assert.equal(view?.requestId, 'req-1');
    assert.equal(view?.kind === 'permission' && view.toolName, 'Write');
    // The CLI's own description, never composed here.
    assert.equal(view?.kind === 'permission' && view.label, 'notes.txt');
    assert.match(
      (view?.kind === 'permission' && view.input) || '',
      /"file_path": "\/proj\/notes\.txt"/
    );
  });

  it('trims an input too big to ride on every poll', () => {
    // A `Write` is the call that prompts most often and carries the whole file.
    const [view] = pendingOf(request({ input: { content: 'x'.repeat(20_000) } }));
    const input = (view?.kind === 'permission' && view.input) || '';
    assert.ok(input.length < 4200, `still ${input.length} characters`);
    assert.ok(input.endsWith('…'), 'and says it was cut');
  });

  it('offers no always-allow unless its producer named every suggestion', () => {
    // An allow hands back every suggestion, so one unnamed destination makes
    // the whole label an understatement.
    assert.equal(where(request({ suggestions: [{ kind: 'addRules', raw: {} }] })), undefined);
    assert.equal(
      where(
        request({
          suggestions: [
            { kind: 'addRules', where: 'this session only', raw: {} },
            { kind: 'addRules', raw: {} }
          ]
        })
      ),
      undefined
    );
    assert.equal(where(request()), undefined, 'and none at all without a suggestion');
  });

  it('names each place an allow would write once', () => {
    assert.equal(
      where(
        request({
          suggestions: [
            { kind: 'addRules', where: 'this session only', raw: {} },
            { kind: 'addDirectories', where: 'this session only', raw: {} },
            { kind: 'setMode', where: 'every session on this machine', raw: {} }
          ]
        })
      ),
      'this session only · every session on this machine'
    );
  });

  function where(r: PendingRequest): string | undefined {
    const [view] = pendingOf(r);
    return view?.kind === 'permission' ? view.always : undefined;
  }

  it('carries an ask as its questions, with no shape refused', () => {
    const q = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({
      question: 'Which way?',
      multiSelect: false,
      options: [{ label: 'Left' }, { label: 'Right' }],
      ...over
    });
    const [view] = pendingOf(
      request({
        ask: true,
        toolName: 'AskUserQuestion',
        questions: [q({ multiSelect: true }), q()]
      })
    );
    assert.equal(view?.kind, 'ask');
    assert.equal(view?.kind === 'ask' && view.questions.length, 2);
  });

  it('carries the available question controls through to the dialog view', () => {
    const questions = [
      { question: 'Which way?', multiSelect: false, options: [{ label: 'Left' }] }
    ];
    for (const [controls, expected] of [
      [{}, {}],
      [{ canNote: true, canReply: true }, {}],
      [{ canNote: false }, { canNote: false }],
      [{ canReply: false }, { canReply: false }]
    ] as const) {
      const [view] = pendingOf(request({ ask: true, questions, ...controls }));
      assert.deepEqual(view, { requestId: 'req-1', kind: 'ask', questions, ...expected });
    }
  });

  it('carries denial reason support to permissions, including unparsed questions', () => {
    for (const ask of [false, true]) {
      for (const [canDenyReason, expected] of [
        [undefined, undefined],
        [true, undefined],
        [false, false]
      ] as const) {
        const [view] = pendingOf(request({ ask, questions: [], canDenyReason }));
        assert.equal(view?.kind, 'permission');
        assert.equal(view?.kind === 'permission' && view.canDenyReason, expected);
      }
    }
  });

  it('keeps the newest work expanded until status, streaming and dialogs all settle', () => {
    const exchanges: ExchangeView[] = [
      { role: 'user', text: 'first', at: 1_000, blocks: [] },
      { role: 'assistant', text: '', at: 2_000, blocks: [{ summary: 'Ran command' }] },
      { role: 'assistant', text: 'first done', at: 3_000, blocks: [{ html: '<p>first done</p>' }] },
      { role: 'user', text: 'next', at: 4_000, blocks: [] },
      { role: 'assistant', text: '', at: 5_000, blocks: [{ summary: 'Ran command' }] },
      { role: 'assistant', text: 'next done', at: 6_000, blocks: [{ html: '<p>next done</p>' }] }
    ];
    for (const [label, status, streaming, pending, hides] of [
      ['settled', 'idle', false, false, [[1], [4]]],
      ['busy', 'busy', false, false, [[1]]],
      ['streaming', 'idle', true, false, [[1]]],
      ['dialog', 'waiting', false, true, [[1]]]
    ] as const) {
      const view = toThread(session({ status }), {
        reachable: true,
        exchanges: exchanges.map((x, i) => (i === 5 && streaming ? { ...x, streaming: true } : x)),
        pending: pending ? [request()] : []
      });
      assert.deepEqual(
        view.folds?.map((fold) => fold.hides),
        hides,
        label
      );
    }
  });

  it('renders an ask whose questions did not parse as something answerable', () => {
    // A dialog with no controls is a session left blocked. The permission
    // dialog has three, and denying is a real answer — the turn survives it.
    const [view] = pendingOf(request({ ask: true, questions: [] }));
    assert.equal(view?.kind, 'permission');
    assert.equal(view?.kind === 'permission' && view.always, undefined);
    assert.match((view?.kind === 'permission' && view.label) || '', /could not read/);
  });

  it('keeps the requests in the order they arrived', () => {
    const views = pendingOf(request({ requestId: 'a' }), request({ requestId: 'b' }));
    assert.deepEqual(
      views.map((v) => v.requestId),
      ['a', 'b']
    );
  });
});

describe('composeThread', () => {
  const owned = session({ source: 'owned' });
  const half = initial({ cwd: '/w', startedAt: 1 });
  const history = { exchanges: [] };

  it('reaches an owned session through a live half with no exit in it', () => {
    assert.equal(composeThread(owned, { history, live: half }, {}).canSend, true);
    const gone = { ...half, exit: { code: 0, signal: null } };
    const ended = composeThread(owned, { history, live: gone }, {});
    assert.equal(ended.canSend, false);
    assert.equal(ended.ended, true);
    assert.equal(composeThread(owned, { history, live: undefined }, {}).canSend, false);
    const background = session({ source: 'owned', background: true });
    assert.equal(composeThread(background, { history, live: half }, {}).canSend, false);
  });

  it('offers folder skills independently of live frames, and none without a live half', () => {
    const here = { skillsHere: ['taught'] };
    assert.deepEqual(composeThread(owned, { history, live: half }, here).skills, ['taught']);
    const own = { ...half, skills: ['own'] };
    assert.deepEqual(composeThread(owned, { history, live: own }, here).skills, ['taught']);
    assert.equal(composeThread(owned, { history, live: undefined }, here).skills, undefined);
  });

  it('draws the outbox off the one half it was given', () => {
    const holding = { ...half, queued: [{ id: 'q', text: 'held', queuedAt: 1 }] };
    const view = composeThread(owned, { history, live: holding }, {});
    assert.deepEqual(
      view.queued?.map((row) => row.text),
      ['held']
    );
  });

  it('draws the words being written as the thread’s tail, never the live half’s copy', () => {
    const said = (text: string): ExchangeView => ({ role: 'assistant', text, blocks: [] });
    const asked: ExchangeView = { role: 'user', text: 'go', blocks: [] };
    const view = composeThread(
      owned,
      {
        history: {
          exchanges: [asked, said('first done')],
          tail: [
            { position: 1, exchange: said('first, being') },
            { position: 2, exchange: said('second, being') }
          ]
        },
        live: half
      },
      {}
    );
    assert.deepEqual(
      view.exchanges.map((x) => ['text' in x ? x.text : '', 'streaming' in x && !!x.streaming]),
      [
        ['go', false],
        ['first, being', true],
        ['first done', false],
        ['second, being', true]
      ]
    );
  });
});

describe('a cache-warming ping in the dock', () => {
  const owned = session({ source: 'owned' });
  const half = initial({ cwd: '/w', startedAt: 1 });
  const turn = (
    role: AuthoredView['role'],
    text: string,
    at?: number,
    more: Partial<AuthoredView> = {}
  ): AuthoredView => ({
    role,
    text,
    at,
    blocks: text ? [{ html: `<p>${text}</p>` }] : [],
    ...more
  });
  const ping = (at: number) =>
    turn('warm', WARM_PROMPT, at, {
      warmEvidence: { phase: 'closed', prefix: 32000, cached: 32000 }
    });
  const ok = (at: number) => turn('assistant', 'OK', at);
  const ran: ExchangeView = {
    role: 'assistant',
    text: '',
    at: 6000,
    blocks: [{ summary: 'Ran command' }]
  };
  const compose = (
    exchanges: ExchangeView[],
    live: LiveState = half,
    tail?: { position: number; exchange: ExchangeView }[]
  ) => composeThread(owned, { history: { exchanges, tail }, live }, {});
  const drawn = (...args: Parameters<typeof compose>) =>
    compose(...args).exchanges.map((x) =>
      'mark' in x ? ['mark', x.mark] : [x.role, x.text, x.at, !!x.streaming]
    );
  const KEPT = '✓ Kept the prompt cache warm';
  const WARMING = 'Warming the prompt cache';
  const MISSED = '✗ Cache warm failed';

  it('requires reuse evidence for newest and persisted pings', () => {
    const missed = {
      ...ping(5000),
      warmEvidence: { phase: 'closed' as const, prefix: 32000, cached: 0 }
    };
    const unknown = { ...ping(8000), warmEvidence: { phase: 'closed' as const } };
    const view = drawn([missed, ok(6000), unknown, ok(9000)], {
      ...half,
      warmTurn: { phase: 'closed', prefix: 32000, cached: 0 }
    });
    assert.equal(view[0]?.[1], MISSED);
    assert.equal(view[1]?.[1], MISSED);
    assert.equal(
      drawn([{ ...ping(5000), warmEvidence: undefined }, ok(6000)])[0]?.[1],
      'Prompt cache reuse unconfirmed'
    );
  });

  it('stops folding at explicitly real unsolicited output, including its streaming tail', () => {
    const real = { ...turn('assistant', 'real work', 7000), maintenance: false };
    const view = compose([ping(5000), { ...ok(6000), maintenance: true }, real]);
    assert.ok(view.exchanges.some((x) => 'text' in x && x.text === 'real work'));
    const streaming = compose([ping(5000), { ...ok(6000), maintenance: true }], half, [
      { position: 2, exchange: real }
    ]);
    assert.ok(streaming.exchanges.some((x) => 'text' in x && x.text === 'real work'));
  });

  it('uses confirmed completion evidence when no authored reply was emitted', () => {
    const completed = {
      ...ping(5000),
      warmEvidence: { phase: 'closed' as const, trafficAt: 6000 }
    };
    assert.equal(drawn([completed])[0]?.[1], 'Prompt cache reuse unconfirmed');
    assert.equal(
      drawn([
        { ...completed, warmEvidence: { ...completed.warmEvidence, prefix: 32000, cached: 32000 } }
      ])[0]?.[1],
      KEPT
    );
  });

  it('keeps a persisted verdict when a newer live ping has not entered the thread yet', () => {
    const prior = { ...ping(5000), warmId: 'prior' };
    const next = { ...half, warmTurn: { id: 'next', phase: 'written' as const } };
    assert.equal(drawn([prior, ok(6000)], next)[0]?.[1], KEPT);
  });

  it('does not revive an old running phase from persisted evidence after resume', () => {
    const prior = {
      ...ping(5000),
      warmEvidence: { phase: 'open' as const, prefix: 32000, cached: 0 }
    };
    assert.equal(drawn([prior, ok(6000)])[0]?.[1], MISSED);
  });

  it('leaves failed tool-only warm evidence reachable outside ordinary work folds', () => {
    const view = compose([turn('user', 'go', 1000), ping(5000), { ...ran, maintenance: true }]);
    assert.ok(
      !view.folds?.some((fold) => fold.hides.includes(2)),
      'warm failure cannot be hidden behind Worked for'
    );
  });

  it('draws as one row at its time, with no reply and no bubble of the reader’s', () => {
    const view = compose([
      turn('user', 'go', 1000),
      turn('assistant', 'done', 2000),
      ping(5000),
      ok(6000)
    ]);
    assert.deepEqual(
      view.exchanges.map((x) => ('mark' in x ? ['mark'] : [x.role, x.text, x.at])),
      [
        ['user', 'go', 1000],
        ['assistant', 'done', 2000],
        ['warm', KEPT, 5000]
      ]
    );
    assert.deepEqual(
      view.exchanges[2] && 'blocks' in view.exchanges[2] && view.exchanges[2].blocks,
      [{ prose: KEPT }]
    );
  });

  it('ends at the next input, a wait or a peer as much as the reader', () => {
    const peer = turn('user', 'from a peer', 7000, { from: 'sess-a' });
    for (const input of [turn('wait', 'All 1 finished.', 7000), peer, turn('user', 'next', 7000)]) {
      assert.deepEqual(drawn([ping(5000), ok(6000), input, turn('assistant', 'on it', 8000)]), [
        ['warm', KEPT, 5000, false],
        [input.role, input.text, 7000, false],
        ['assistant', 'on it', 8000, false]
      ]);
    }
    const typed: ExchangeView = { mark: 'skill', skill: 'lavish', by: 'you' };
    assert.deepEqual(drawn([ping(5000), ok(6000), typed, turn('assistant', 'loaded', 8000)]), [
      ['warm', KEPT, 5000, false],
      ['mark', 'skill'],
      ['assistant', 'loaded', 8000, false]
    ]);
  });

  it('does not guess missing ping ids or suppress orphaned named replies', () => {
    const first = { ...ping(5000), warmId: 'w1' };
    const second = { ...ping(9000), warmId: 'w2' };
    const rows = [
      first,
      turn('user', 'real', 7000),
      second,
      turn('cli', 'anonymous error', 10000, { maintenance: true }),
      turn('assistant', 'orphan OK', 11000, { maintenance: true, warmId: 'missing' })
    ];
    const view = compose(rows).exchanges;
    assert.equal(
      view.filter((x): x is AuthoredView => 'role' in x && x.role === 'warm')[1]?.text,
      KEPT
    );
    assert.ok(view.some((x) => 'role' in x && x.text === 'anonymous error'));
    assert.ok(view.some((x) => 'role' in x && x.text === 'orphan OK'));
    assert.ok(view.some((x) => 'role' in x && x.text === 'real'));
  });

  it('draws two pings as two rows', () => {
    assert.deepEqual(drawn([ping(5000), ok(6000), ping(9000), ok(9500)]), [
      ['warm', KEPT, 5000, false],
      ['warm', KEPT, 9000, false]
    ]);
  });

  it('keeps what went wrong in a ping, and never calls it kept', () => {
    // A tool it reached for, an error the CLI wrote, a reply cut short, or no
    // answer at all: each is evidence the reader may need, and none is a cache
    // kept warm.
    assert.deepEqual(drawn([ping(5000), ran]), [
      ['warm', MISSED, 5000, false],
      ['assistant', '', 6000, false]
    ]);
    assert.deepEqual(drawn([ping(5000), ok(6000), turn('cli', 'API Error', 6500)]), [
      ['warm', MISSED, 5000, false],
      ['cli', 'API Error', 6500, false]
    ]);
    assert.deepEqual(drawn([ping(5000), turn('assistant', 'O', 6000, { cut: true })]), [
      ['warm', MISSED, 5000, false],
      ['assistant', 'O', 6000, false]
    ]);
    assert.deepEqual(drawn([ping(5000)]), [['warm', MISSED, 5000, false]]);
    const failed = { ...half, warmTurn: { phase: 'closed' as const, failed: true as const } };
    assert.deepEqual(drawn([ping(5000), ok(6000)], failed), [['warm', MISSED, 5000, false]]);
    const { exchanges } = compose([turn('user', 'go', 1000), ping(5000), ran]);
    assert.ok(exchanges.length === 3, 'the tool it ran is still in the thread');
  });

  it('says it is warming while it is out, and never flashes its reply', () => {
    for (const phase of ['written', 'open'] as const) {
      const out = { ...half, warmTurn: { phase } };
      assert.deepEqual(drawn([ping(5000)], out), [['warm', WARMING, 5000, false]]);
      assert.deepEqual(
        drawn([ping(5000)], out, [{ position: 1, exchange: turn('assistant', 'O') }]),
        [['warm', WARMING, 5000, false]]
      );
    }
    // A reply still arriving is the ping still out, latch or none.
    assert.deepEqual(
      drawn([ping(5000)], half, [{ position: 1, exchange: turn('assistant', 'O') }]),
      [['warm', WARMING, 5000, false]]
    );
    // Only the newest ping is the latch's.
    const out = { ...half, warmTurn: { phase: 'open' as const } };
    assert.deepEqual(drawn([ping(5000), ok(6000), ping(9000)], out), [
      ['warm', KEPT, 5000, false],
      ['warm', WARMING, 9000, false]
    ]);
  });

  it('neither opens a group of its own nor folds', () => {
    const view = compose([
      turn('user', 'go', 1000),
      { ...ran, at: 1500 },
      turn('assistant', 'done', 2000),
      ping(5000),
      ok(6000)
    ]);
    assert.deepEqual(
      view.folds?.map((fold) => fold.hides),
      [[1]]
    );
  });
});
