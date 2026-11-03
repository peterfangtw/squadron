import * as assert from 'node:assert/strict';
import * as messageFacts from '../../core/message_facts';
import { before, describe, it } from 'node:test';
import { unwrapMessage, wrapMessage, wrapWait } from '../../core/coordination/send';
import { INIT, Live, RESULT, askRequest, live, run, setup } from './live_helpers';
before(setup);

describe('the outbox', () => {
  // Held outbox: the panel owns the queue. Entries are records; drain retires
  // on write (dequeueHead), not on init.

  const q = (id: string, text: string) => ({ id, text, queuedAt: 1 });

  it('remembers what was held, oldest first', () => {
    const state = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    assert.deepEqual(
      state.queued.map((e) => e.text),
      ['first', 'second']
    );
  });

  it('merges a message another session sent like any other', () => {
    const wrapped = { id: 'p', text: wrapMessage('from the peer', 'sess-a'), queuedAt: 1 };
    const state = live.mergeQueued(
      live.enqueueAhead(live.enqueue(run([]), q('a', 'mine')), wrapped)
    );
    assert.deepEqual(
      state.queued.map((e) => e.id),
      ['p+a']
    );
    assert.equal(
      unwrapMessage(state.queued[0]?.text ?? ''),
      undefined,
      'the greedy anchor refuses it rather than filing it under sess-a'
    );
  });

  it('folds a peer message into the run in front of it', () => {
    const wrapped = { id: 'p', text: wrapMessage('from the peer', 'sess-a'), queuedAt: 1 };
    const held = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    const state = live.mergeQueued(live.enqueue(held, wrapped));
    assert.deepEqual(
      state.queued.map((e) => e.id),
      ['a+b+p']
    );
  });

  it('merges a wait converging', () => {
    const converged = { id: 'w', text: wrapWait('All 2 sessions have finished.'), queuedAt: 1 };
    const held = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    const state = live.mergeQueued(live.enqueue(held, converged));
    assert.deepEqual(
      state.queued.map((e) => e.id),
      ['a+b+w']
    );
  });

  it('still merges two rows the reader typed', () => {
    const two = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    assert.equal(live.mergeQueued(two).queued[0]?.text, 'first\n\nsecond');
  });

  it('keeps one shared target on the turn it merges', () => {
    const target = { model: 'gpt-5.6-sol', effort: 'high' };
    const two = live.enqueue(live.enqueue(run([]), { ...q('a', 'first'), target }), {
      ...q('b', 'second'),
      target
    });
    const merged = live.mergeQueued(two);
    assert.equal(merged.queued.length, 1);
    assert.deepEqual(merged.queued[0]?.target, target);
  });

  it('does not merge messages that were sent at different targets', () => {
    const two = live.enqueue(
      live.enqueue(run([]), { ...q('a', 'first'), target: { effort: 'medium' } }),
      { ...q('b', 'second'), target: { effort: 'high' } }
    );
    assert.equal(live.mergeQueued(two), two);
  });

  it('merges past a skipped id and parks it at the end', () => {
    const two = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    const three = live.enqueue(two, q('c', 'third'));
    const merged = live.mergeQueued(three, new Set(['a']));
    assert.equal(merged.queued[0]?.text, 'second\n\nthird');
    assert.equal(merged.queued[1]?.text, 'first');
  });

  it('puts an ahead message at the head, not the tail', () => {
    const held = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    const state = live.enqueueAhead(held, q('c', 'the interrupt'));
    assert.deepEqual(
      state.queued.map((e) => e.text),
      ['the interrupt', 'first', 'second']
    );
  });

  it('takes an ahead message into an empty outbox like any other', () => {
    const state = live.enqueueAhead(run([]), q('a', 'alone'));
    assert.deepEqual(
      state.queued.map((e) => e.text),
      ['alone']
    );
  });

  // A message another session sent must not become what this one is called.
  it('still names the session after the first thing held, ahead or not', () => {
    const first = live.enqueue(run([]), q('a', 'the work'));
    assert.equal(live.enqueueAhead(first, q('b', 'a peer speaking')).firstPrompt, 'the work');
  });

  it('does not retire on init — only dequeueHead does', () => {
    const two = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    const running = run([INIT], two);
    assert.equal(running.queued.length, 2, 'init leaves the outbox alone');
    assert.deepEqual(
      live.dequeueHead(two).queued.map((e) => e.text),
      ['second']
    );
    assert.deepEqual(live.dequeueHead(live.dequeueHead(two)).queued, []);
  });

  it('holds the head it wrote until the turn it started ends', () => {
    // The gap the dock used to show nothing for: a held row leaves the outbox
    // on our write, and the CLI's own copy of it is a poll away.
    const two = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    const wrote = live.dequeueHead(two);
    assert.equal(wrote.inFlight?.text, 'first');
    assert.equal(live.dequeueHead(wrote).inFlight?.text, 'second', 'the next write replaces it');
    assert.equal(run([INIT], wrote).inFlight?.text, 'first', 'still held while the turn runs');
    assert.equal(run([INIT, RESULT], wrote).inFlight, undefined, 'the turn ended');
  });

  it('holds nothing for a message that was never written', () => {
    const one = live.enqueue(run([]), q('a', 'first'));
    assert.equal(live.dismissQueued(one, 'a').inFlight, undefined, 'a dismiss is not a send');
    assert.equal(live.mergeQueued(live.enqueue(one, q('b', 'second'))).inFlight, undefined);
  });

  it('survives the idle event that arrives behind the result it drained on', () => {
    // Observed against a real child: `result`, our drain, then the CLI's own
    // `session_state_changed: idle` repeating what the result already said —
    // and an unconditional clear in `endTurn` wiped the message a frame before
    // the turn it started opened. Nothing was on screen for the whole turn.
    const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
    const drained = live.dequeueHead(live.enqueue(run([INIT, RESULT]), q('a', 'first')));
    assert.equal(drained.inFlight?.text, 'first');
    assert.equal(run([idle], drained).inFlight?.text, 'first', 'an idle edge ends no turn');
    // The turn it did start still retires it, which is the whole bound.
    assert.equal(run([INIT, RESULT], drained).inFlight, undefined);
  });

  it('reads busy from our write until the turn it started ends', () => {
    // The write moves the activity clock past the reader's mark while the CLI
    // has not spoken yet, so an idle reading in that gap is unread `done`: a
    // card went IDLE, DONE, BUSY for every prompt sent.
    const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
    const drained = live.dequeueHead(live.enqueue(run([INIT, RESULT]), q('a', 'first')));
    assert.equal(live.shownStatus(drained), 'busy');
    assert.equal(drained.running, false, 'a drain reads the CLI, not the word shown');
    assert.equal(live.shownStatus(run([idle], drained)), 'busy', 'the stale idle ends nothing');
    assert.equal(live.shownStatus(run([INIT, RESULT], drained)), 'idle');
  });

  it('offers no turn to interrupt until the CLI opens it', () => {
    const held = { pid: 1, startedAt: 1, updatedAt: 1, brand: 'claude' as const };
    const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
    const drained = live.dequeueHead(live.enqueue(run([INIT, RESULT]), q('a', 'first')));
    const pending = (state: ReturnType<typeof run>) => live.toSession(state, held, 'w').turnPending;
    assert.equal(pending(drained), true);
    assert.equal(pending(run([idle], drained)), true, 'the stale idle opens nothing');
    assert.equal(pending(run([INIT], drained)), undefined, 'the CLI opened the turn');
    assert.equal(pending(run([INIT, RESULT], drained)), undefined);
  });

  it('lets the echo go when the child does, not only when a turn ends', () => {
    // `withExit` runs the same `endTurn`, which is the only reason a dead
    // session does not keep drawing a message nothing will ever answer.
    const wrote = live.dequeueHead(live.enqueue(run([]), q('a', 'first')));
    assert.equal(live.withExit(wrote, { code: 0, signal: null }).inFlight, undefined);
  });

  it('holds send-now as the one message it merged, not the head of it', () => {
    // Send now merges and then drains through the same write, so the echo says
    // what the session was actually told — all N, joined — rather than row one.
    const two = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    const wrote = live.dequeueHead(live.mergeQueued(two));
    assert.equal(wrote.inFlight?.text, 'first\n\nsecond');
    assert.deepEqual(wrote.queued, [], 'nothing held behind it');
  });

  it('dismisses one entry by id', () => {
    const two = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    assert.deepEqual(
      live.dismissQueued(two, 'a').queued.map((e) => e.text),
      ['second']
    );
    assert.equal(live.dismissQueued(two, 'nobody'), two);
  });

  it('merges the outbox into one message, so send-now is one turn', () => {
    const two = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    const merged = live.mergeQueued(two);
    assert.equal(merged.queued.length, 1);
    assert.equal(merged.queued[0]?.text, 'first\n\nsecond');
    assert.equal(merged.queued[0]?.queuedAt, 1, 'ordered by the oldest thing in it');
  });

  it('stops the merge at a command, so a queued /effort reaches the CLI whole', () => {
    // A slash command is one only when it opens the message. Merged in, it is
    // prose the session reads out. `/effort` ahead of a targeted send is the
    // writer the wall protects.
    const cmd = { id: 'r', text: '/effort high', queuedAt: 2, command: true as const };
    const three = live.enqueue(
      live.enqueue(live.enqueue(run([]), q('a', 'first')), cmd),
      q('b', 'after')
    );
    const merged = live.mergeQueued(three);
    assert.deepEqual(
      merged.queued.map((e) => e.text),
      ['first', '/effort high', 'after'],
      'the run before it merged; the wall and its tail stayed put'
    );
  });

  it('leaves a command at the head alone rather than merging what follows it', () => {
    const cmd = { id: 'r', text: '/effort high', queuedAt: 1, command: true as const };
    const two = live.enqueue(live.enqueue(run([]), cmd), q('b', 'after'));
    assert.equal(live.mergeQueued(two), two, 'nothing to merge in front of it');
  });

  it('merges the run in front of a command, and keeps the order', () => {
    const cmd = { id: 'r', text: '/effort high', queuedAt: 3, command: true as const };
    const state = live.enqueue(
      live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second')),
      cmd
    );
    const merged = live.mergeQueued(state);
    assert.deepEqual(
      merged.queued.map((e) => e.text),
      ['first\n\nsecond', '/effort high']
    );
    assert.equal(merged.queued[0]?.id, 'a+b');
  });

  it('never names the session after a command', () => {
    // `firstPrompt` is the titler's only input. `/effort high` is a thing done
    // to the turn, not the first thing anybody asked of it.
    const cmd = { id: 'r', text: '/effort high', queuedAt: 1, command: true as const };
    assert.equal(live.enqueue(run([]), cmd).firstPrompt, undefined);
    const after = live.enqueue(live.enqueue(run([]), cmd), q('a', 'the real task'));
    assert.equal(after.firstPrompt, 'the real task');
  });

  it('gives the merged entry its own id, so a stale Dismiss cannot drop all N', () => {
    // Another window's rows are a publish and a poll old. Under the head's id,
    // their Dismiss of row one would drop every merged message and be told it
    // worked; every id in the merge collides with nothing and misses loudly.
    const two = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    const merged = live.mergeQueued(two);
    assert.equal(merged.queued[0]?.id, 'a+b');
    assert.equal(live.dismissQueued(merged, 'a'), merged, 'the stale row misses');
    assert.deepEqual(
      live.dismissQueued(merged, 'a+b').queued,
      [],
      'the row that is there does not'
    );
  });

  it('carries every image across the merge, and skips the wordless rows', () => {
    const shot = { mediaType: 'image/png', data: 'AAA' };
    const withImages = live.enqueue(live.enqueue(run([]), { ...q('a', 'look'), images: [shot] }), {
      ...q('b', ''),
      images: [shot]
    });
    const merged = live.mergeQueued(withImages);
    assert.equal(merged.queued[0]?.text, 'look', 'no trailing blank lines for the paste');
    assert.equal(merged.queued[0]?.images?.length, 2);
  });

  it('renumbers the image markers so the second message still names its own', () => {
    // The images flatten into one list, so `b`'s only shot is now the third.
    // A marker left at #1 would point the session at `a`'s screenshot.
    const shot = { mediaType: 'image/png', data: 'AAA' };
    const two = live.enqueue(
      live.enqueue(run([]), { ...q('a', 'a [Image #1] [Image #2]'), images: [shot, shot] }),
      { ...q('b', 'b [Image #1]'), images: [shot] }
    );
    const merged = live.mergeQueued(two);
    assert.equal(merged.queued[0]?.text, 'a [Image #1] [Image #2]\n\nb [Image #3]');
    assert.equal(merged.queued[0]?.images?.length, 3);
  });

  it('leaves a number the reader typed about something else alone', () => {
    // Both halves in one message: `#2` is `b`'s own second image and shifts,
    // `#9` names nothing this message attached and is prose, not a reference.
    const shot = { mediaType: 'image/png', data: 'AAA' };
    const two = live.enqueue(live.enqueue(run([]), { ...q('a', 'first'), images: [shot] }), {
      ...q('b', 'as in [Image #9] earlier, and [Image #2]'),
      images: [shot, shot]
    });
    assert.equal(
      live.mergeQueued(two).queued[0]?.text,
      'first\n\nas in [Image #9] earlier, and [Image #3]'
    );
  });

  it('advances the offset past a message that was only a screenshot', () => {
    // The wordless entry contributes no text to join, and its image still has
    // to push the next message's markers along.
    const shot = { mediaType: 'image/png', data: 'AAA' };
    const two = live.enqueue(live.enqueue(run([]), { ...q('a', ''), images: [shot] }), {
      ...q('b', 'this one [Image #1]'),
      images: [shot]
    });
    assert.equal(live.mergeQueued(two).queued[0]?.text, 'this one [Image #2]');
  });

  it('merges twice without shifting the markers twice', () => {
    const shot = { mediaType: 'image/png', data: 'AAA' };
    const two = live.enqueue(live.enqueue(run([]), { ...q('a', 'first'), images: [shot] }), {
      ...q('b', 'second [Image #1]'),
      images: [shot]
    });
    const once = live.mergeQueued(two);
    assert.equal(live.mergeQueued(once), once, 'an outbox of one is already merged');
  });

  it('keeps each merged message whole beside the joined text', () => {
    const peer = { id: 'p', text: wrapMessage('from the peer', 'sess-a'), queuedAt: 1 };
    const wait = { id: 'w', text: wrapWait('All 2 sessions have finished.'), queuedAt: 1 };
    const held = live.enqueue(live.enqueue(live.enqueue(run([]), peer), wait), q('a', 'mine'));
    const [row] = live.mergeQueued(held).queued;
    assert.deepEqual(
      row?.parts?.map((part) => part.id),
      ['p', 'w', 'a']
    );
    assert.equal(row?.parts?.[0]?.text, peer.text, 'the envelope, untouched');
  });

  it('flattens the parts of a row merged twice', () => {
    const two = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    const again = live.mergeQueued(live.enqueue(live.mergeQueued(two), q('c', 'third')));
    assert.deepEqual(
      again.queued[0]?.parts?.map((part) => part.id),
      ['a', 'b', 'c']
    );
  });

  it('puts no parts on a row nothing merged into', () => {
    const one = live.enqueue(run([]), q('a', 'first'));
    assert.equal(one.queued[0]?.parts, undefined);
    assert.deepEqual(live.segments(one.queued[0] ?? q('x', '')), [{ text: 'first', images: [] }]);
  });

  it('lays a merged row out as one segment per message, each image after its own words', () => {
    const shot = { mediaType: 'image/png', data: 'AAA' };
    const other = { mediaType: 'image/png', data: 'BBB' };
    const held = live.enqueue(
      live.enqueue(live.enqueue(run([]), { ...q('a', 'look [Image #1]'), images: [shot] }), {
        ...q('b', ''),
        images: [other]
      }),
      { ...q('c', 'and this [Image #1]'), images: [shot] }
    );
    const [row] = live.mergeQueued(held).queued;
    assert.ok(row);
    assert.deepEqual(live.segments(row), [
      { text: 'look [Image #1]\n\n', images: [shot] },
      { text: '', images: [other] },
      { text: 'and this [Image #3]', images: [shot] }
    ]);
    assert.equal(row.parts?.[2]?.text, 'and this [Image #1]', 'a part keeps what was typed');
  });

  it('separates only words that more words follow', () => {
    const shot = { mediaType: 'image/png', data: 'AAA' };
    const held = live.enqueue(live.enqueue(run([]), q('a', 'first')), {
      ...q('b', ''),
      images: [shot]
    });
    const [row] = live.mergeQueued(held).queued;
    assert.ok(row);
    assert.deepEqual(
      live.segments(row).map((segment) => segment.text),
      ['first', '']
    );
  });

  it('writes the same words segment by segment as the joined text holds', () => {
    const shot = { mediaType: 'image/png', data: 'AAA' };
    const held = live.enqueue(
      live.enqueue(live.enqueue(run([]), { ...q('a', 'a [Image #1]'), images: [shot] }), {
        ...q('b', ''),
        images: [shot]
      }),
      { ...q('c', 'c [Image #1]'), images: [shot] }
    );
    const [row] = live.mergeQueued(held).queued;
    assert.ok(row);
    assert.equal(
      live
        .segments(row)
        .map((segment) => segment.text)
        .join(''),
      row.text
    );
  });

  it('leaves an outbox of one alone', () => {
    const one = live.enqueue(run([]), q('a', 'first'));
    assert.equal(live.mergeQueued(one), one);
    const none = run([]);
    assert.equal(live.mergeQueued(none), none);
  });

  it('canDrain only when idle with no open request', () => {
    assert.equal(live.canDrain(run([])), true);
    assert.equal(live.canDrain(run([INIT])), false);
    assert.equal(live.canDrain(run([INIT, askRequest])), false);
    assert.equal(live.canDrain(run([INIT, RESULT])), true);
  });

  it('ignores an empty send', () => {
    const state = run([]);
    assert.equal(live.enqueue(state, q('a', '')), state);
  });

  it('keeps the first thing said, which is what a title is generated from', () => {
    const two = live.enqueue(live.enqueue(run([]), q('a', 'first')), q('b', 'second'));
    assert.equal(two.firstPrompt, 'first');
    assert.equal(live.dequeueHead(live.dequeueHead(two)).firstPrompt, 'first');
    assert.equal(run([]).firstPrompt, undefined);
  });

  it('has nothing to name a session after when the first send was only a screenshot', () => {
    // The title is persisted into the transcript, so `[Image #1]` would be the
    // name every other window and every resume saw from then on. A marker is a
    // pointer, not something the reader said.
    const shot = { mediaType: 'image/png', data: 'AAA' };
    const only = live.enqueue(run([]), { ...q('a', '[Image #1]'), images: [shot] });
    assert.equal(only.firstPrompt, undefined);
    assert.equal(only.queued.length, 1, 'the message itself still goes');

    const then = live.enqueue(only, q('b', 'now compare them'));
    assert.equal(then.firstPrompt, 'now compare them', 'the first words said, whenever they came');
  });

  it('never names a session after an envelope it was handed', () => {
    // The second half of "the outbox holds what went on the wire". Both senders
    // of a wrapped message pass a `describe` today, so this never fired — but
    // the invariant was resting on two callers remembering, and what it guards
    // is not a repaint: `firstPrompt` feeds the CLI's titler and that title is
    // persisted into the transcript for every window and every resume to read.
    const said = 'All 2 sessions you were waiting on have finished.';
    const woke = live.enqueue(run([]), q('a', wrapWait(said)));
    assert.equal(woke.firstPrompt, said);

    const peer = live.enqueue(run([]), q('b', wrapMessage('take the redirect', 'sess-a')));
    assert.equal(peer.firstPrompt, 'take the redirect');
    assert.equal(
      peer.queued[0]?.text,
      wrapMessage('take the redirect', 'sess-a'),
      'the CLI is still written the envelope — only the name comes off it'
    );
  });

  it('names a session after `describe` when the text is not what it is about', () => {
    // A mentioned workflow puts a line of its own on the wire, and the briefing
    // under it. The session is still called after the work. The literal here is
    // hand-written on purpose — this is about `describe` winning over whatever
    // the text is, so it must not move every time the wording does.
    const sent = 'Following the workflow "Ship review" (ship-review).';
    const one = live.enqueue(run([]), {
      ...q('a', sent),
      describe: 'Ship review: fix the redirect'
    });
    assert.equal(one.firstPrompt, 'Ship review: fix the redirect');
    assert.equal(one.queued[0]?.text, sent, 'the CLI is still written what it was sent');

    const later = live.enqueue(one, {
      ...q('b', 'and again'),
      describe: 'Ship review: something else'
    });
    assert.equal(later.firstPrompt, 'Ship review: fix the redirect', 'first only — never a rename');

    const blank = live.enqueue(run([]), { ...q('a', 'plain words'), describe: '  ' });
    assert.equal(blank.firstPrompt, 'plain words', 'nothing to say falls back to the prose');
  });

  it('names a session after the words, not the marker among them', () => {
    const shot = { mediaType: 'image/png', data: 'AAA' };
    const one = live.enqueue(run([]), {
      ...q('a', '[Image #1] why is this clipped?'),
      images: [shot]
    });
    assert.equal(one.firstPrompt, 'why is this clipped?');
  });
});

describe('correlated message facts', () => {
  const entry = (id: string, correlation = id) => ({
    id,
    correlation,
    text: 'same words',
    queuedAt: 1
  });
  const facts = (state: ReturnType<Live['initial']>) => state.messageFacts;

  it('keeps every merged original through delivery and successful completion', () => {
    let state = live.initial({ cwd: '/repo', startedAt: 1 });
    state = live.enqueue(state, entry('a'));
    state = live.enqueue(state, entry('b'));
    assert.deepEqual(facts(state), [
      { correlation: 'a', phase: 'queued' },
      { correlation: 'b', phase: 'queued' }
    ]);
    state = live.dequeueHead(live.mergeQueued(state));
    assert.deepEqual(facts(state), [
      { correlation: 'a', phase: 'processing' },
      { correlation: 'b', phase: 'processing' }
    ]);
    state = live.endTurn(live.inTurn(state, {}), 'done');
    assert.deepEqual(facts(state), [
      { correlation: 'a', phase: 'done' },
      { correlation: 'b', phase: 'done' }
    ]);
  });

  it('retains an unclassified close until its stated outcome arrives', () => {
    let state = live.dequeueHead(
      live.enqueue(live.initial({ cwd: '/repo', startedAt: 1 }), entry('a'))
    );
    state = live.endTurn(live.inTurn(state, {}));
    assert.deepEqual(facts(state), [{ correlation: 'a', phase: 'unknown' }]);
    state = live.endTurn(state, 'done');
    assert.deepEqual(facts(state), [{ correlation: 'a', phase: 'done' }]);
  });

  it('never promotes dismissed, interrupted or exited messages to success', () => {
    let state = live.enqueue(live.initial({ cwd: '/repo', startedAt: 1 }), entry('dismiss'));
    state = live.dismissQueued(state, 'dismiss');
    state = live.inTurn(live.dequeueHead(live.enqueue(state, entry('cut'))), {});
    state = live.endTurn(state, 'interrupted');
    state = live.endTurn(state, 'done');
    state = live.inTurn(live.dequeueHead(live.enqueue(state, entry('exit'))), {});
    state = live.enqueue(state, entry('held'));
    state = live.withExit(state, { code: null, signal: 'SIGKILL' });
    state = live.endTurn(state, 'done');
    assert.deepEqual(
      facts(state),
      ['dismiss', 'cut', 'exit', 'held'].map((correlation) => ({
        correlation,
        phase: 'unsuccessful',
        ...(correlation === 'dismiss' ? { dismissed: true } : {})
      }))
    );
  });

  it('does not associate warm or effort-command rows sharing a prompt identity', () => {
    let state = live.initial({ cwd: '/repo', startedAt: 1 });
    state = live.enqueue(state, { ...entry('a'), command: true });
    state = live.enqueue(state, entry('a'));
    state = live.endTurn(live.inTurn(live.dequeueHead(state), {}), 'done', true);
    assert.deepEqual(facts(state), [{ correlation: 'a', phase: 'queued' }]);
    state = live.endTurn(live.inTurn(live.dequeueHead(state), {}), 'done');
    state = live.warmDrain(state, { ...entry('warm'), warm: true });
    state = live.endTurn(live.inTurn(state, {}), 'error');
    assert.deepEqual(facts(state), [{ correlation: 'a', phase: 'done' }]);
  });
});

describe('bounded correlated history', () => {
  it('keeps unresolved evidence while bounding facts and native turn associations', () => {
    const turns = new messageFacts.MessageTurns();
    let state = live.initial({ cwd: '/repo', startedAt: 1 });
    const old = { id: 'old', correlation: 'old', text: 'same words', queuedAt: 1 };
    state = live.endTurn(live.inTurn(live.dequeueHead(live.enqueue(state, old)), {}));
    turns.remember('native-old', old);
    for (let index = 0; index <= messageFacts.MESSAGE_FACTS_KEPT; index++) {
      const row = {
        id: String(index),
        correlation: String(index),
        text: 'same words',
        queuedAt: 1
      };
      state = live.endTurn(live.inTurn(live.dequeueHead(live.enqueue(state, row)), {}), 'done');
      turns.remember(`native-${index}`, row);
    }
    assert.equal(state.messageFacts?.length, messageFacts.MESSAGE_FACTS_KEPT);
    assert.deepEqual(
      state.messageFacts?.find((fact) => fact.correlation === 'old'),
      { correlation: 'old', phase: 'unknown' }
    );
    assert.equal(
      turns.settle(state, 'native-old', 'done'),
      state,
      'evicted ownership cannot claim success'
    );
    assert.deepEqual(state.messageFacts?.at(-1), {
      correlation: String(messageFacts.MESSAGE_FACTS_KEPT),
      phase: 'done'
    });
  });
});

describe('terminal attribution after fact eviction', () => {
  it('keeps a retained native interruption final while an unknown close can still succeed', () => {
    const turns = new messageFacts.MessageTurns();
    const row = (correlation: string) => ({
      id: correlation,
      correlation,
      text: 'work',
      queuedAt: 1
    });
    const interrupted = row('interrupted');
    let state = live.inTurn(
      live.dequeueHead(live.enqueue(live.initial({ cwd: '/repo', startedAt: 1 }), interrupted)),
      {}
    );
    turns.remember('native-interrupted', interrupted);
    state = turns.settle(state, 'native-interrupted', 'interrupted');
    state = live.endTurn(state, 'interrupted');
    const uncertain = row('uncertain');
    state = live.inTurn(live.dequeueHead(live.enqueue(state, uncertain)), {});
    turns.remember('native-uncertain', uncertain);
    state = turns.settle(state, 'native-uncertain');
    state = live.endTurn(state);
    for (let index = 0; index <= messageFacts.MESSAGE_FACTS_KEPT; index++) {
      const held = row(`dismissed-${index}`);
      state = live.dismissQueued(live.enqueue(state, held), held.id);
    }
    assert.equal(
      state.messageFacts?.find((fact) => fact.correlation === interrupted.correlation),
      undefined
    );
    assert.equal(
      state.messageFinality?.find((fact) => fact.correlation === interrupted.correlation),
      undefined
    );
    state = turns.settle(state, 'native-interrupted', 'done');
    assert.ok(
      !state.messageFacts?.some(
        (fact) => fact.correlation === interrupted.correlation && fact.phase === 'done'
      )
    );

    state = turns.settle(state, 'native-uncertain', 'done');
    assert.deepEqual(
      state.messageFacts?.find((fact) => fact.correlation === uncertain.correlation),
      { correlation: 'uncertain', phase: 'done' }
    );
  });

  it('captures reducer-confirmed interruption before eviction from a retained native turn', () => {
    const turns = new messageFacts.MessageTurns();
    const row = { id: 'cut', correlation: 'cut', text: 'work', queuedAt: 1 };
    let state = live.inTurn(
      live.dequeueHead(live.enqueue(live.initial({ cwd: '/repo', startedAt: 1 }), row)),
      {}
    );
    turns.remember('native-cut', row);
    state = turns.apply(state, live.endTurn(state, 'interrupted'));
    for (let index = 0; index <= messageFacts.MESSAGE_FACTS_KEPT; index++) {
      const held = { ...row, id: `held-${index}`, correlation: `held-${index}` };
      state = turns.apply(state, live.dismissQueued(live.enqueue(state, held), held.id));
    }
    assert.equal(
      state.messageFacts?.find((fact) => fact.correlation === 'cut'),
      undefined
    );
    state = live.endTurn(state, 'done');
    state = turns.settle(state, 'native-cut', 'done');
    assert.ok(
      !state.messageFacts?.some((fact) => fact.correlation === 'cut' && fact.phase === 'done')
    );
  });
});
