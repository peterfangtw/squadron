import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import {
  answerOpen,
  answerSend,
  attachWorkflow,
  cardView,
  enter,
  groupView,
  newDraft,
  openPanel,
  sendDraft,
  stateMessage,
  threadView,
  typeIn,
  workflowView,
  type Panel
} from '../harness';

/**
 * A draft's first send, from the press to the session's first thread. The
 * prompt is seated as the first turn the moment the start is in flight, and
 * nothing after that may take it away — not the reveal, not a push that names
 * the pid before its thread exists, not the send's own answer — until the
 * thread that replaces it draws the same prompt in the same place.
 * docs/mockups/chat-first-send.html is the comp; the motion over these states
 * is the hand-check's, since jsdom lays nothing out.
 */
describe('a first send lands where it was seated', () => {
  const CWD = '/Users/someone/proj';
  const WORKFLOWS = [workflowView({ id: 'ship', label: 'plan→build→review' })];
  const extra = { workflows: WORKFLOWS };
  const board = (sessions = [] as ReturnType<typeof cardView>[]) => [
    groupView({ cwd: CWD, sessions })
  ];
  const started = cardView({ pid: 8, startedAt: 8_000, owned: true, fullCwd: CWD });

  const first = (p: Panel): Element | null | undefined =>
    p.window.document.querySelector('#thread')?.firstElementChild;
  const seat = (p: Panel): string => {
    const turn = first(p);
    assert.ok(turn?.matches('.turn.user'), 'the prompt is not the first turn');
    return turn?.querySelector('.body')?.textContent ?? '';
  };
  const loading = (p: Panel): boolean =>
    /Loading/.test(p.window.document.getElementById('thread')?.textContent ?? '');

  const animatedPanel = (t: TestContext): Panel => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const p = openPanel(t);
    Object.defineProperty(p.window.performance, 'now', { value: () => Date.now() });
    p.window.Element.prototype.animate = () => {
      const flight = {
        oncancel: null as (() => void) | null,
        cancel: (): void => flight.oncancel?.()
      };
      return flight as unknown as Animation;
    };
    return p;
  };

  for (const readyAt of [100, 500]) {
    it(`sends immediately at ${readyAt} ms while respecting the 400 ms presentation minimum`, (t) => {
      const p = animatedPanel(t);
      p.push(stateMessage(board(), extra));
      sendDraft(p, 'look at the parser', CWD);
      const d = p.window.document;
      const startup = d.getElementById('chat-startup')!;
      const workflow = d.getElementById('wattach')?.textContent;
      t.mock.timers.tick(readyAt);
      answerOpen(p, 8, 8_000);
      assert.ok(p.posted.some((m) => m.type === 'send' && m.text === 'look at the parser'));
      p.push(
        stateMessage(board([started]), {
          ...extra,
          thread: threadView({
            pid: 8,
            startedAt: 8_000,
            owned: true,
            canSend: true,
            exchanges: [
              {
                role: 'user',
                text: 'look at the parser',
                blocks: [{ prose: 'look at the parser' }]
              },
              { role: 'assistant', text: 'on it', blocks: [{ html: '<p>on it</p>' }] }
            ]
          })
        })
      );
      if (readyAt < 400) {
        assert.equal(startup.hidden, false, 'fast startup flashed away');
        assert.equal(d.getElementById('wattach')?.textContent, workflow);
        assert.equal(d.getElementById('input')?.getAttribute('aria-disabled'), 'true');
        assert.doesNotMatch(d.getElementById('thread')?.textContent ?? '', /on it/);
        t.mock.timers.tick(400 - readyAt - 1);
        assert.equal(startup.hidden, false);
        t.mock.timers.tick(1);
      }
      assert.equal(startup.hidden, true);
      assert.match(d.getElementById('thread')?.textContent ?? '', /on it/);
      assert.equal(d.getElementById('input')?.getAttribute('aria-disabled'), 'false');
    });
  }

  it('leaves the minimum display immediately when another session is selected', (t) => {
    const p = animatedPanel(t);
    const other = cardView({ pid: 3, startedAt: 3_000, owned: true, fullCwd: CWD });
    p.push(stateMessage(board([other]), extra));
    sendDraft(p, 'look at the parser', CWD);
    answerOpen(p, 8, 8_000);
    const d = p.window.document;
    d.querySelector<HTMLElement>('.card[data-pid="3"]')?.click();
    p.push(
      stateMessage(board([other, started]), {
        ...extra,
        thread: threadView({ pid: 3, startedAt: 3_000, name: 'other session', owned: true })
      })
    );
    assert.equal(d.getElementById('chat-startup')?.hidden, true);
    t.mock.timers.tick(400);
    assert.equal(d.querySelector('#chat-head span.name')?.textContent, 'other session');
    assert.equal(d.getElementById('chat-startup')?.hidden, true);
    assert.equal(p.posted.filter((m) => m.type === 'send').length, 1);
  });

  it('keeps the prompt through the reveal, a bare push and the send’s answer', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    sendDraft(p, 'look at the parser', CWD);
    assert.equal(seat(p), 'look at the parser');

    answerOpen(p, 8, 8_000);
    assert.equal(loading(p), false, 'the reveal painted Loading…');
    assert.equal(seat(p), 'look at the parser', 'the reveal took the prompt away');

    p.push(stateMessage(board([started]), extra));
    assert.equal(loading(p), false, 'a push with no thread painted Loading…');
    assert.equal(seat(p), 'look at the parser');

    answerSend(p, { ok: true });
    assert.equal(loading(p), false, 'the send’s answer painted Loading…');
    assert.equal(seat(p), 'look at the parser');

    p.push(
      stateMessage(board([started]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: true })
      })
    );
    assert.equal(seat(p), 'look at the parser', 'the thread moved the prompt');
  });

  it('ends startup feedback before the reveal hands off the composer', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    sendDraft(p, 'look at the parser', CWD);
    const head = p.window.document.getElementById('chat-head') as HTMLElement;
    const startup = p.window.document.getElementById('chat-startup') as HTMLElement;
    const feedback = (): void => {
      assert.equal(startup.hidden, false);
      assert.ok(startup.querySelector('.spinner'));
      assert.match(startup.textContent ?? '', /^Starting in /);
      assert.equal(seat(p), 'look at the parser');
    };

    feedback();
    answerOpen(p, 8, 8_000);
    assert.equal(startup.hidden, true, 'startup feedback outlived native startup');
    assert.equal(seat(p), 'look at the parser');
    p.push(stateMessage(board([started]), extra));
    assert.equal(startup.hidden, true, 'a bare push restored startup feedback');
    assert.equal(seat(p), 'look at the parser');

    p.push(
      stateMessage(board([started]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, name: 'parser', canSend: true })
      })
    );
    assert.equal(startup.hidden, true, 'the start outlived the thread');
    const name = head.querySelector('span.name') as Element;
    assert.notEqual(p.window.getComputedStyle(head).display, 'none');
    assert.equal(name.textContent, 'parser');
  });

  it('puts the starting head down for another card picked mid-start', (t) => {
    const other = cardView({ pid: 3, startedAt: 3_000, owned: true, fullCwd: CWD });
    const p = openPanel(t);
    p.push(stateMessage(board([other]), extra));
    sendDraft(p, 'look at the parser', CWD);
    const head = p.window.document.getElementById('chat-head') as HTMLElement;
    p.window.document.querySelector<HTMLElement>('.card[data-pid="3"]')?.click();
    assert.equal(head.classList.contains('starting'), false, 'card 3 wears the start');
    assert.equal(head.querySelector('.spinner'), null);
    assert.equal(p.window.document.getElementById('chat-startup')?.hidden, true);
  });

  /** The seat is the node the press flew there, and a start lands faster than
   *  the flight: replacing it at the reveal cuts the motion wherever the start
   *  is quick, which the smoke run found is nearly everywhere. */
  it('keeps the very node the press seated, across the reveal', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    sendDraft(p, 'look at the parser', CWD);
    const seated = first(p);
    answerOpen(p, 8, 8_000);
    assert.ok(seated && first(p) === seated, 'the reveal replaced the seat');
  });

  /** The seat is kept for the session the draft became, not for any card
   *  whose stand-in happens to read the same. */
  it('replaces the seat for another card that reads the same', (t) => {
    const other = cardView({ pid: 3, startedAt: 3_000, owned: true, fullCwd: CWD });
    const p = openPanel(t);
    p.push(stateMessage(board([other]), extra));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="3"]')?.click();
    typeIn(p, 'look at the parser');
    enter(p);
    sendDraft(p, 'look at the parser', CWD);
    const seated = first(p);
    p.window.document.querySelector<HTMLElement>('.card[data-pid="3"]')?.click();
    assert.ok(first(p) !== seated, 'another card kept the draft’s seat');
  });

  it('draws a workflow’s first send the same from seat to thread', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    attachWorkflow(p, 'plan→build→review');
    typeIn(p, 'ship the parser');
    enter(p);
    const seated = seat(p);

    answerOpen(p, 8, 8_000);
    assert.equal(seat(p), seated, 'the reveal redrew the prompt');
    p.push(
      stateMessage(board([started]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: true })
      })
    );
    assert.equal(seat(p), seated, 'the thread redrew the prompt');
  });

  /** Where the seat is *not* kept, said rather than promised: a session busy on
   *  arrival queues the prompt, and the queue is drawn at the composer. */
  it('hands a prompt the new session queued to the outbox', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    sendDraft(p, 'look at the parser', CWD);
    answerOpen(p, 8, 8_000);
    answerSend(p, { ok: true });
    p.push(
      stateMessage(board([started]), {
        ...extra,
        thread: threadView({
          pid: 8,
          startedAt: 8_000,
          owned: true,
          canSend: true,
          status: 'busy',
          queued: [{ id: 'q1', text: 'look at the parser' }]
        })
      })
    );
    const drawn = [...p.window.document.querySelectorAll('#thread .turn.user .body')].filter(
      (b) => b.textContent === 'look at the parser'
    );
    assert.equal(drawn.length, 1, 'the prompt is drawn twice, or not at all');
    assert.ok(drawn[0]?.closest('.outbox'), 'the queued prompt is not in the outbox');
  });

  it('still says Loading… for a card the reader opens', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board([started]), extra));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="8"]')?.click();
    assert.equal(loading(p), true);
  });

  /**
   * The host selects what a start brought up (`revealSession`), and a reader
   * who went to another card while it was starting is not looking at it. The
   * dock stays where the reader is; this is the half that tells the host so,
   * or its pushes follow the new session and the card on screen waits on
   * Loading… for a thread that never comes.
   */
  it('hands the host back the card the reader went to mid-start', (t) => {
    const other = cardView({ pid: 3, startedAt: 3_000, owned: true, fullCwd: CWD });
    const p = openPanel(t);
    p.push(stateMessage(board([other]), extra));
    sendDraft(p, 'look at the parser', CWD);
    p.window.document.querySelector<HTMLElement>('.card[data-pid="3"]')?.click();
    const mark = p.posted.length;

    answerOpen(p, 8, 8_000);
    const selects = p.posted.slice(mark).filter((m) => m.type === 'select');
    assert.deepEqual(
      selects.map((m) => (m.type === 'select' ? m.pid : undefined)),
      [3],
      'the host was not told the reader is still on card 3'
    );
  });

  /**
   * The last beat of the same motion: the session's first reply rises in under
   * the prompt, once. The dots come first and do not spend it — they are the
   * session working, not answering — and it belongs to the session the draft
   * became, never to a card the reader went to instead.
   */
  describe('the first reply', () => {
    const asked = {
      role: 'user' as const,
      text: 'look at the parser',
      blocks: [{ prose: 'look at the parser' }]
    };
    const answered = {
      role: 'assistant' as const,
      text: 'on it',
      blocks: [{ html: '<p>on it</p>' }]
    };
    const thread = (over: Parameters<typeof threadView>[0] = {}) =>
      threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: true, ...over });
    const push = (p: Panel, over: Parameters<typeof threadView>[0] = {}): void =>
      p.push(stateMessage(board([started]), { ...extra, thread: thread(over) }));
    const rising = (p: Panel): string[] =>
      [...p.window.document.querySelectorAll('#thread .turn.rise')].map(
        (turn) => turn.querySelector('.body, .raw, p')?.textContent ?? turn.className
      );

    it('rises once, on reply content and not on the dots before it', (t) => {
      const p = openPanel(t);
      p.push(stateMessage(board(), extra));
      sendDraft(p, 'look at the parser', CWD);
      answerOpen(p, 8, 8_000);
      push(p, { status: 'busy', exchanges: [asked] });
      assert.ok(p.window.document.querySelector('#thread .working'), 'no dots to not rise');
      assert.deepEqual(rising(p), [], 'the dots spent the rise');

      push(p, { status: 'idle', exchanges: [asked, answered] });
      assert.equal(rising(p).length, 1, 'the reply did not rise');

      push(p, {
        status: 'idle',
        exchanges: [
          asked,
          answered,
          { ...asked, text: 'and the lexer' },
          { ...answered, text: 'done' }
        ]
      });
      assert.equal(rising(p).length, 1, 'a later reply rose too');
    });

    it('does not rise for a reply that arrived while a draft was open', (t) => {
      const p = openPanel(t);
      p.push(stateMessage(board(), extra));
      sendDraft(p, 'look at the parser', CWD);
      answerOpen(p, 8, 8_000);
      newDraft(p);
      p.push(stateMessage(board([started]), extra));
      const card = p.window.document.querySelector<HTMLElement>('.card[data-pid="8"]');
      assert.ok(card, 'no card to go back in by');
      card.click();
      push(p, { status: 'idle', exchanges: [asked, answered] });
      assert.deepEqual(rising(p), [], 'a reply already written rose on the way back in');
    });

    it('does not rise for a start the reader left', (t) => {
      const other = cardView({ pid: 3, startedAt: 3_000, owned: true, fullCwd: CWD });
      const p = openPanel(t);
      p.push(stateMessage(board([other]), extra));
      sendDraft(p, 'look at the parser', CWD);
      p.window.document.querySelector<HTMLElement>('.card[data-pid="3"]')?.click();
      answerOpen(p, 8, 8_000);
      p.push(
        stateMessage(board([other, started]), {
          ...extra,
          thread: threadView({
            pid: 3,
            startedAt: 3_000,
            owned: true,
            canSend: true,
            exchanges: [asked, answered]
          })
        })
      );
      assert.deepEqual(rising(p), [], 'the card the reader went to took the rise');
    });
  });
});
