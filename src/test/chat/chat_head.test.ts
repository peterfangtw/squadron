import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertedMessageBody,
  cardView,
  groupView,
  openPanel,
  openThread,
  permissionRequest,
  stateMessage,
  threadView,
  unreachableThread,
  Panel
} from '../harness';

describe('the dock head', () => {
  for (const [label, facts, word, facet] of [
    ['failed turn', { turnOutcome: 'error' as const }, 'failed', 'failed'],
    ['finished steps', { completion: { total: 4, completed: 4 } }, 'done', 'done'],
    ['unfinished steps', { completion: { total: 4, completed: 2 } }, 'stalled', 'stalled'],
    ['unread output', { unseen: true }, 'done', 'done'],
    ['waiting request', { status: 'waiting' as const, waitingFor: 'done' }, 'done', 'waiting']
  ] as const) {
    it(`uses the selected card's reading in the head for ${label}`, (t) => {
      const card = cardView(facts);
      const thread = threadView(card);
      const p = openThread(t, thread);
      p.push(stateMessage([groupView({ sessions: [card] })], { thread }));
      const doc = p.window.document;
      assert.equal(doc.querySelector('#chat-head .pill')?.textContent, word);
      assert.equal(doc.querySelector('.card .pill')?.textContent, word);
      assert.deepEqual(
        new Set(doc.querySelector('#chat-head')?.classList ?? []),
        new Set([card.status, facet])
      );
    });
  }

  it('clears the failed head facet when another turn runs and finishes', (t) => {
    const failed = threadView(cardView({ turnOutcome: 'error' }));
    const p = openThread(t, failed);
    const doc = p.window.document;
    const push = (thread: ThreadView): void =>
      p.push(stateMessage([groupView({ sessions: [thread] })], { thread }));
    assert.equal(doc.querySelector('#chat-head .pill')?.textContent, 'failed');
    assert.equal((doc.querySelector('#chat-interrupt') as HTMLElement).style.display, 'none');

    push(threadView({ pid: failed.pid, startedAt: failed.startedAt, status: 'busy' }));
    assert.equal(doc.querySelector('#chat-head .pill')?.textContent, 'busy');
    assert.equal(doc.querySelector('#chat-head')?.classList.contains('failed'), false);
    assert.notEqual((doc.querySelector('#chat-interrupt') as HTMLElement).style.display, 'none');

    push(threadView({ pid: failed.pid, startedAt: failed.startedAt }));
    assert.equal(doc.querySelector('#chat-head .pill')?.textContent, 'idle');
    assert.equal(doc.querySelector('#chat-head')?.classList.contains('failed'), false);
    assert.equal((doc.querySelector('#chat-interrupt') as HTMLElement).style.display, 'none');
  });

  it('offers no interrupt until the CLI opens the turn', (t) => {
    const sent = threadView({ status: 'busy', turnPending: true });
    const p = openThread(t, sent);
    const doc = p.window.document;
    const button = doc.querySelector('#chat-interrupt') as HTMLElement;
    assert.equal(doc.querySelector('#chat-head .pill')?.textContent, 'busy');
    assert.equal(button.style.display, 'none');

    // Rebuilt rather than spread: the push ships the host's answer afresh.
    const opened = threadView({ status: 'busy' });
    p.push(stateMessage([groupView({ sessions: [opened] })], { thread: opened }));
    assert.notEqual(button.style.display, 'none');
  });

  it('states time since the last reply in the head', (t) => {
    const p = openThread(t, threadView({ updatedAt: Date.now() - 12 * 60_000 }));
    const since = p.window.document.querySelector('#chat-head .since');
    assert.equal(since?.textContent, '12m ago');
    assert.equal(since?.classList.contains('warm'), false);
  });

  /**
   * `tickHead` is `tickStamps`'s two lines, and takes its dedupe with it — the
   * head has replaced its own stamp every second for as long as it has had one,
   * and a tip resting on it has been rebuilt just as often. Twelve minutes old:
   * the words are the same at both ends of a beat.
   */
  it('holds the head stamp a beat had nothing to say about', async (t) => {
    const p = openThread(t, threadView({ updatedAt: Date.now() - 12 * 60_000 }));
    const doc = p.window.document;
    const since = doc.querySelector('#chat-head .since');
    assert.equal(since?.textContent, '12m ago', 'the fixture drew the wrong reading');
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(
      doc.querySelector('#chat-head .since'),
      since,
      'a beat with nothing to say replaced the head stamp anyway'
    );
  });

  /**
   * The head's stamp and the card's are the same reading of the same field, so
   * the only thing that can make them disagree is how often each is redrawn.
   * `renderThread` runs on the 3 s push alone, which left the dock stepping in
   * threes and trailing the card by up to that — "10s ago" beside "13s ago"
   * for one session.
   */
  it('advances the head stamp on the same beat as the card', async (t) => {
    const p = openPanel(t);
    // Card and head first draw on two different pushes; a loaded box can put a
    // second boundary between them, so both read one frozen instant.
    const real = p.window.Date.now;
    const frozen = real();
    p.window.Date.now = () => frozen;
    const updatedAt = frozen - 1500;
    const groups = [groupView({ sessions: [cardView({ pid: 7, updatedAt })] })];
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 7, updatedAt }) }));
    const stamp = (sel: string): string | null | undefined =>
      p.window.document.querySelector(sel)?.textContent;
    const first = stamp('#chat-head .since');
    assert.equal(first, stamp('.card .since'), 'the two disagreed before any tick');
    p.window.Date.now = real;

    // Two beats of the ticker with no push behind it — which is every second of
    // an idle session's life. Two rather than one: the ticker is a 1000ms
    // interval and the old 1100ms wait left it 100ms of lateness before the card
    // had not ticked and the case failed on its own guard, which is what a
    // loaded box spent it on.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.notEqual(stamp('.card .since'), first, 'the card never ticked, so this proves nothing');
    assert.equal(stamp('#chat-head .since'), stamp('.card .since'), 'the head trailed the card');
  });

  it('counts the head from a refreshed cache, as the card does', (t) => {
    const p = openThread(
      t,
      threadView({
        updatedAt: Date.now() - 70 * 60_000,
        cacheFrom: Date.now() - 10 * 60_000,
        cacheUntil: Date.now() + 50 * 60_000
      })
    );
    const stamp = p.window.document.querySelector('#chat-head .since');
    assert.equal(stamp?.classList.contains('cold'), false);
    assert.equal(stamp?.textContent, '10m ago');
  });

  it('marks the head cold once the prompt cache is gone', (t) => {
    const p = openThread(t, threadView({ updatedAt: Date.now() - 70 * 60_000 }));
    const since = p.window.document.querySelector('#chat-head .since');
    assert.equal(since?.textContent, '1h ago ❄︎');
    assert.ok(since?.classList.contains('cold'), 'no cold mark past the hour');
  });

  it('leaves a busy session unmarked, however long the turn has run', (t) => {
    // Same exemption as the card: a busy `updatedAt` is when the turn began,
    // and a session talking to the API right now has a warm cache.
    const p = openThread(t, threadView({ status: 'busy', updatedAt: Date.now() - 70 * 60_000 }));
    const since = p.window.document.querySelector('#chat-head .since');
    assert.equal(since?.classList.contains('cold'), false);
    assert.equal(since?.classList.contains('warm'), false);
  });

  it('offers interrupt in the head while busy, and posts it', (t) => {
    const p = openThread(t, threadView({ pid: 7, status: 'busy' }));
    const button = p.window.document.getElementById('chat-interrupt') as HTMLElement;
    assert.notEqual(button.style.display, 'none', 'no interrupt in a busy head');
    button.click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'interrupt', pid: 7 });
  });

  it('shows an unrouted interrupt refusal in the composer', (t) => {
    const p = openThread(t, threadView({ pid: 7, status: 'busy' }));
    (p.window.document.getElementById('chat-interrupt') as HTMLElement).click();
    p.push({
      type: 'sendResult',
      pid: 7,
      ok: false,
      reason: 'That session is not one this window can write to.'
    });
    assert.equal(
      p.window.document.getElementById('blocked')?.textContent,
      'That session is not one this window can write to.'
    );
  });

  it('interrupts busy, and waiting only when this window drives the pipe', (t) => {
    const base = { pid: 7, startedAt: Date.now() - 60_000 };
    const p = openThread(t, threadView({ ...base, status: 'idle', owned: false }));
    const groups = [groupView({ sessions: [cardView(base)] })];
    const shown = (): boolean =>
      (p.window.document.getElementById('chat-interrupt') as HTMLElement).style.display !== 'none';
    for (const status of ['busy', 'waiting', 'idle', 'unknown'] as const) {
      for (const owned of [true, false] as const) {
        p.push(stateMessage(groups, { thread: threadView({ ...base, status, owned }) }));
        assert.equal(
          shown(),
          status === 'busy' || (status === 'waiting' && owned),
          `${status}, owned ${owned}`
        );
      }
    }
  });

  it('offers interrupt while an owned session waits on a dialog', (t) => {
    // A request blocks the turn, so the card reads `waiting` rather than `busy`
    // — and without this the one control that retracts it is off screen exactly
    // when the reader wants it.
    const p = openThread(
      t,
      threadView({ pid: 7, status: 'waiting', owned: true, pending: [permissionRequest()] })
    );
    const button = p.window.document.getElementById('chat-interrupt') as HTMLElement;
    assert.notEqual(button.style.display, 'none');
    button.click();
    assert.deepEqual(
      assertedMessageBody(p.posted.at(-1)),
      { type: 'interrupt', pid: 7 },
      'and asks for it outright'
    );
  });

  it('withholds interrupt from a waiting session this window does not drive', (t) => {
    // The prompt is the CLI's own, in a shell this window may not even reach,
    // and the host answers a non-busy terminal pid with nothing. A button
    // that can only do nothing does not belong in the head.
    const p = openThread(t, threadView({ pid: 7, status: 'waiting', owned: false }));
    assert.equal(
      (p.window.document.getElementById('chat-interrupt') as HTMLElement).style.display,
      'none'
    );
  });

  it('drops interrupt from the head when the turn ends', (t) => {
    const p = openThread(t, threadView({ pid: 7, status: 'busy' }));
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })], {
        thread: threadView({ pid: 7, status: 'idle' })
      })
    );
    assert.equal(
      (p.window.document.getElementById('chat-interrupt') as HTMLElement).style.display,
      'none'
    );
  });

  it('stops the session from the head', (t) => {
    const p = openThread(t, threadView());
    p.window.document.getElementById('chat-stop')?.click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'close', pid: 101 });
    // The dock stays open: the card goes dead on the next poll, and the
    // transcript of a stopped session is still worth reading.
    assert.ok(!p.window.document.body.classList.contains('closed'));
  });

  it('copies a reference to the selected session from the head', (t) => {
    const p = openThread(t, threadView());
    p.window.document.getElementById('chat-link')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'copyRef', pid: 101 });
  });

  it('offers the copy on a session no terminal owns', (t) => {
    // Unlike jump and stop: nothing about a reference needs a shell.
    const p = openThread(t, threadView({ canControl: false }));
    assert.notEqual(p.window.document.getElementById('chat-link')?.style.display, 'none');
    p.window.document.getElementById('chat-link')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'copyRef', pid: 101 });
  });

  it('hides the stop on a session no terminal owns', (t) => {
    const p = openThread(t, threadView({ canControl: false }));
    assert.equal(p.window.document.getElementById('chat-stop')?.style.display, 'none');
  });

  it('offers the stop on a session the panel drives itself', (t) => {
    const p = openThread(t, threadView({ owned: true }));
    assert.equal(p.window.document.getElementById('chat-stop')?.style.display, '');
  });
});

describe('renaming a session from the head', () => {
  const nameEl = (p: Panel) =>
    p.window.document.querySelector('#chat-head span.name') as HTMLElement;
  const box = (p: Panel) => p.window.document.getElementById('chat-rename') as HTMLInputElement;

  /** Open the box, type, and press the key — the whole path a reader takes. */
  function rename(p: Panel, typed: string, key = 'Enter'): void {
    nameEl(p).click();
    box(p).value = typed;
    box(p).dispatchEvent(new p.window.KeyboardEvent('keydown', { key, bubbles: true }));
  }

  it('posts what the reader typed', (t) => {
    const p = openThread(t, threadView({ pid: 42, name: 'agent-39' }));
    rename(p, 'Rename test');
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'rename',
      pid: 42,
      title: 'Rename test'
    });
  });

  it('paints no answer of its own', (t) => {
    // The name belongs to `sessions/<pid>.json`: the CLI writes it and the next
    // poll folds it onto the card. A head that painted its own answer would be
    // stating a string the file has not agreed to yet — and would go on stating
    // it if the session refused the rename.
    const p = openThread(t, threadView({ pid: 42, name: 'agent-39' }));
    rename(p, 'Rename test');
    assert.equal(nameEl(p).textContent, 'agent-39');
    assert.equal(box(p).hidden, true, 'the box closes on Enter either way');
  });

  it('abandons on Escape', (t) => {
    const p = openThread(t, threadView({ pid: 42, name: 'agent-39' }));
    rename(p, 'Rename test', 'Escape');
    assert.equal(box(p).hidden, true);
    assert.equal(
      p.posted.some((m) => m.type === 'rename'),
      false
    );
  });

  it('posts nothing for a blank, or for the name it already had', (t) => {
    // A blank is not a name, and an unchanged one would say nothing.
    const p = openThread(t, threadView({ pid: 42, name: 'agent-39' }));
    rename(p, '   ');
    rename(p, 'agent-39');
    assert.equal(
      p.posted.some((m) => m.type === 'rename'),
      false
    );
  });

  it('survives the poll that lands mid-edit', (t) => {
    // The regression this guard exists for: the poll runs every 3s and the name
    // it writes is the *old* one, since the new one is not on disk until Enter.
    // A repaint that wrote it would undo the typing under the reader's cursor.
    const p = openThread(t, threadView({ pid: 42, name: 'agent-39' }));
    nameEl(p).click();
    box(p).value = 'half-typed';
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 42 })] })], {
        thread: threadView({ pid: 42, name: 'agent-39' })
      })
    );
    assert.equal(box(p).hidden, false, 'the box was closed by a repaint');
    assert.equal(box(p).value, 'half-typed');
  });

  it('closes a box left open over another session’s card', (t) => {
    // Enter here would rename a session that is no longer on screen.
    const p = openThread(t, threadView({ pid: 42, name: 'agent-39' }));
    nameEl(p).click();
    const other = threadView({ pid: 7, name: 'other' });
    const groups = [groupView({ sessions: [cardView({ pid: 42 }), other] })];
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="7"]')?.click();
    p.push(stateMessage(groups, { thread: other }));
    assert.equal(box(p).hidden, true);
    assert.equal(nameEl(p).textContent, 'other');
  });

  it('abandons an edit when the pid is replaced by another session', (t) => {
    const p = openThread(t, threadView({ pid: 42, startedAt: 5_000, name: 'old' }));
    nameEl(p).click();
    box(p).value = 'meant for old';
    const replacement = cardView({ pid: 42, startedAt: 20_000, name: 'new' });
    p.push(
      stateMessage([groupView({ sessions: [replacement] })], {
        thread: threadView({ pid: 42, startedAt: 20_000, name: 'new' })
      })
    );
    assert.equal(box(p).hidden, true);
    box(p).dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(
      p.posted.some((message) => message.type === 'rename'),
      false
    );
  });

  it('offers nothing on a session this window cannot write to', (t) => {
    // This window does not drive it, so the head does not offer a rename.
    const p = openThread(t, unreachableThread({ name: 'agent-39' }));
    assert.equal(nameEl(p).getAttribute('role'), null);
    nameEl(p).click();
    assert.equal(box(p).hidden, true);
  });
});
