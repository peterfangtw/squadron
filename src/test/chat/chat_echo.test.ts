import * as assert from 'node:assert/strict';
import * as send from '../../core/coordination/send';
import * as views from '../../ui/views';
import * as viewsHelpers from '../views_helpers';
import { describe, it } from 'node:test';
import {
  cardView,
  enter,
  groupView,
  openPanel,
  stateMessage,
  threadView,
  composerKey,
  importComposer
} from '../harness';
import { settledTurn, sonnetPick, userTurnBody } from './chat_helpers';

describe('a send handing over to its turn', () => {
  for (const delay of [0, 6000]) {
    it(`lets a typed skill settle the echo after a ${delay} ms fixture delay`, (t) => {
      let now = Date.now();
      t.mock.method(Date, 'now', () => now);
      // Sent from the composer, `/simplify` never comes back as a user turn. Left
      // to the grace timer the echo would hang under its own chip and then vanish.
      const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
      const p = openPanel(t);
      now += delay;
      p.push(stateMessage(groups));
      p.window.document.querySelector<HTMLElement>('.card')?.click();
      p.push(stateMessage(groups, { thread: threadView({ exchanges: [] }) }));

      importComposer(p, '/simplify');
      composerKey(p, 'Enter');
      assert.ok(p.window.document.querySelector('#thread .turn.sending'), 'no echo was shown');

      p.push(
        stateMessage(groups, {
          thread: threadView({ exchanges: [{ mark: 'skill', skill: 'simplify', by: 'you' }] })
        })
      );
      assert.equal(p.window.document.querySelector('#thread .turn.sending'), null);
      assert.equal(
        p.window.document.querySelector('#thread .turn.skill .cmd')?.textContent,
        '/simplify'
      );
    });
  }

  it('settles the echo of a built-in command, arguments and all', (t) => {
    // `/model haiku` is marked by name alone — the CLI writes the name in one
    // entry and the arguments in another — so the echo cannot be matched whole
    // against the chip. Left unsettled it sits, with the working dots under it,
    // for the full grace beneath an answer already on screen.
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(groups, { thread: threadView({ exchanges: [] }) }));

    importComposer(p, '/model haiku');
    enter(p);
    assert.ok(p.window.document.querySelector('#thread .turn.sending'), 'no echo was shown');

    p.push(
      stateMessage(groups, {
        thread: threadView({
          exchanges: [
            { mark: 'skill', skill: 'model', by: 'you' },
            {
              role: 'cli',
              local: true,
              text: 'Set model to Haiku 4.5',
              blocks: [{ html: '<p>Set model to Haiku 4.5</p>' }],
              at: p.window.Date.now()
            }
          ]
        })
      })
    );
    assert.equal(p.window.document.querySelector('#thread .turn.sending'), null);
    assert.equal(p.window.document.querySelector('#thread .working'), null);
  });

  it('does not settle prose on a command chip that landed beside it', (t) => {
    // The chip names the command that produced it. Prose asks for a turn, and a
    // command answered in the same breath says nothing about it.
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(groups, { thread: threadView({ exchanges: [] }) }));

    importComposer(p, 'what does this do?');
    enter(p);
    p.push(
      stateMessage(groups, {
        thread: threadView({ exchanges: [{ mark: 'skill', skill: 'model', by: 'you' }] })
      })
    );
    assert.ok(p.window.document.querySelector('#thread .turn.sending'), 'the echo was given up');
  });

  it('retires a drained message from the outbox as the transcript takes it', (t) => {
    // The drain writes the head of the outbox and pops it. The panel sees both
    // halves — one fewer held, one more turn — and the row has to leave with
    // its message rather than the outbox keeping a copy beside the turn.
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();

    const oneText =
      'one\n\nIncoming files\n```text\n{"conversation":"original-a","message":"correlation-a","omitted":2}\n\'/installed path/squadron-fetch-file\' --conversation-id original-a --message-id correlation-a --file-id file-a\n```';
    const twoText =
      'two\n\nIncoming files\n```text\n{"conversation":"original-b","message":"correlation-b","omitted":0}\n\'/installed path/squadron-fetch-file\' --conversation-id original-b --message-id correlation-b --file-id file-b\n```';
    const first = { id: 'a', text: oneText };
    const second = { id: 'b', text: twoText };
    const held = [first, second];
    p.push(stateMessage(groups, { thread: threadView({ status: 'busy', queued: held }) }));
    assert.equal(p.window.document.querySelectorAll('#thread .outbox .turn.queued').length, 2);

    // First drained: gone from the outbox, back as the turn the CLI wrote down.
    const one: ExchangeView = { role: 'user', text: oneText, blocks: [{ prose: oneText }] };
    p.push(
      stateMessage(groups, {
        thread: threadView({ status: 'busy', exchanges: [one], queued: [second] })
      })
    );
    const rows = p.window.document.querySelectorAll('#thread .outbox .turn.queued');
    assert.equal(rows.length, 1, 'one held after the drain');
    assert.equal(rows[0]?.querySelector('.body')?.textContent?.includes('correlation-b'), true);
    assert.match(
      p.window.document.querySelector('#thread .qbar .lbl')?.textContent ?? '',
      /^1 held/
    );
    const settled = [
      ...p.window.document.querySelectorAll('#thread .turn.user:not(.queued) .body')
    ].at(-1);
    assert.ok(settled?.textContent?.includes('correlation-a'));
    assert.equal(settled?.textContent?.includes('correlation-b'), false);
    assert.equal(rows[0]?.querySelector('img'), null);

    // Emptied: no rail, no subheader — the block goes with its last message.
    const two: ExchangeView = { role: 'user', text: twoText, blocks: [{ prose: twoText }] };
    p.push(
      stateMessage(groups, {
        thread: threadView({ status: 'busy', exchanges: [one, two], queued: [] })
      })
    );
    assert.equal(p.window.document.querySelector('#thread .outbox'), null);
    assert.equal(p.window.document.querySelectorAll('#thread .turn.queued').length, 0);
  });

  it('keeps a drained message on screen while the transcript catches up', (t) => {
    // The gap between the two halves above: the row leaves the outbox on our
    // write and the CLI's copy of it arrives a poll later, and the message the
    // reader queued used to be on screen nowhere in between.
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();

    const held = { id: 'a', text: 'one' };
    p.push(stateMessage(groups, { thread: threadView({ status: 'busy', queued: [held] }) }));
    p.push(stateMessage(groups, { thread: threadView({ status: 'busy', sending: [held] }) }));
    assert.equal(p.window.document.querySelector('#thread .outbox'), null);
    const echo = p.window.document.querySelector('#thread .turn.user.sending');
    assert.equal(echo?.querySelector('.body')?.textContent, 'one');

    // And leaves when the turn does arrive — the host stops sending it.
    const one: ExchangeView = { role: 'user', text: 'one', blocks: [{ prose: 'one' }] };
    p.push(stateMessage(groups, { thread: threadView({ status: 'busy', exchanges: [one] }) }));
    assert.equal(p.window.document.querySelector('#thread .turn.user.sending'), null);
    assert.equal(
      [...p.window.document.querySelectorAll('#thread .turn.user .body')].at(-1)?.textContent,
      'one'
    );
  });

  it('keeps identical sending messages visible until their own authors are recorded', (t) => {
    const groups = [groupView({ sessions: [cardView({ pid: 101, startedAt: 0 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    const parts = [
      { id: 'p', text: send.wrapMessage('done', 'peer-a') },
      { id: 'q', text: send.wrapMessage('done', 'peer-b') },
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
      ['peer-b', ['peer-a', 'you']],
      ['peer-a', ['you']],
      [undefined, []]
    ] as const) {
      exchanges.push({
        role: 'user',
        text: 'done',
        from,
        at: 6_000,
        blocks: [{ prose: 'done' }]
      });
      const thread = views.toThread(viewsHelpers.session({ pid: 101, status: 'busy' }), {
        reachable: true,
        exchanges,
        inFlight
      });
      p.push(stateMessage(groups, { thread }));
      const rows = [...p.window.document.querySelectorAll('#thread .turn.sending')];
      assert.deepEqual(
        rows.map(
          (row) =>
            row.querySelector('.who .attr')?.textContent ??
            row.querySelector('.who')?.childNodes[0]?.textContent
        ),
        remaining
      );
    }
    p.push(
      stateMessage(groups, {
        thread: views.toThread(viewsHelpers.session({ pid: 101, status: 'idle' }), {
          reachable: true,
          exchanges,
          inFlight
        })
      })
    );
    assert.equal(p.window.document.querySelector('#thread .working'), null);
  });

  it('draws one bubble when both echoes describe the same message', (t) => {
    // An idle send is drained within a beat of being enqueued, so the composer's own
    // echo and the host's can be standing over one message at once.
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(groups, { thread: threadView({ status: 'idle' }) }));

    importComposer(p, 'ship it');
    enter(p);
    p.push(
      stateMessage(groups, {
        thread: threadView({ status: 'busy', sending: [{ id: 'a', text: 'ship it' }] })
      })
    );
    assert.equal(p.window.document.querySelectorAll('#thread .turn.user.sending').length, 1);
  });

  it('keeps the echo’s look when the transcript replaces it', (t) => {
    const typed = `see **x**\n\n- one\n- two\n\nask ${sonnetPick}`;
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openPanel(t);
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(groups, { thread: threadView({ status: 'busy' }) }));
    importComposer(p, typed);
    enter(p);
    const echo = p.window.document.querySelector('#thread .turn.sending .body')?.innerHTML;
    assert.ok(echo?.includes('<strong>'), 'the echo was not formatted');

    p.push(stateMessage(groups, { thread: threadView({ exchanges: [settledTurn(typed)] }) }));
    assert.equal(p.window.document.querySelector('#thread .turn.sending'), null);
    assert.equal(userTurnBody(p)?.innerHTML, echo);
  });
});
