import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardView, groupView, openThread, stateMessage, threadView } from '../harness';

describe('the notices above the thread', () => {
  it('shows recovery loading until history lands, and only then reports an empty conversation', (t) => {
    const view = threadView({ historyState: 'loading', exchanges: [] });
    const p = openThread(t, view);
    const text = (): string => p.window.document.getElementById('thread')?.textContent ?? '';
    assert.match(text(), /Loading conversation/);
    assert.doesNotMatch(text(), /No conversation found/);
    assert.ok(p.window.document.querySelector('#thread .spinner'));
    const push = (over: Partial<ThreadView>): void =>
      p.push(
        stateMessage([groupView({ sessions: [cardView({ pid: view.pid })] })], {
          thread: { ...view, ...over }
        })
      );
    push({
      historyState: undefined,
      exchanges: [{ role: 'user', text: 'Recovered words', blocks: [{ prose: 'Recovered words' }] }]
    });
    assert.match(text(), /Recovered words/);
    assert.equal(p.window.document.querySelector('#thread .spinner'), null);
    push({ historyState: undefined, exchanges: [] });
    assert.match(text(), /No conversation found/);
  });

  it('distinguishes failed recovery from empty history and keeps incoming turns visible', (t) => {
    const view = threadView({ historyState: 'failed', exchanges: [] });
    const p = openThread(t, view);
    assert.match(
      p.window.document.getElementById('thread')?.textContent ?? '',
      /history could not be loaded/
    );
    assert.doesNotMatch(
      p.window.document.getElementById('thread')?.textContent ?? '',
      /No conversation found/
    );
    for (const historyState of ['loading', 'failed'] as const) {
      p.push(
        stateMessage([groupView({ sessions: [cardView({ pid: view.pid })] })], {
          thread: {
            ...view,
            historyState,
            exchanges: [
              { role: 'assistant', text: 'Live words', blocks: [{ html: '<p>Live words</p>' }] }
            ]
          }
        })
      );
      assert.match(p.window.document.getElementById('thread')?.textContent ?? '', /Live words/);
    }
  });
  it('says so above the thread when older turns went unread', (t) => {
    const p = openThread(
      t,
      threadView({
        truncated: true,
        exchanges: [{ role: 'user', text: 'go', blocks: [{ prose: 'go' }] }]
      })
    );
    const thread = p.window.document.getElementById('thread');
    const elided = thread?.querySelector('.elided');
    assert.ok(elided, 'expected a notice that the history is cut');
    // Above the oldest turn it has, because that is where the missing ones went.
    assert.equal(thread?.firstElementChild, elided);
    // Points at the file, where the whole thing still is — it pointed at the
    // session's terminal until row 53 took the last card that had one.
    assert.match(elided.textContent ?? '', /file on disk/i);
  });

  it('says so above the thread when it is reading the CLI\u2019s own transcript', (t) => {
    const p = openThread(
      t,
      threadView({
        fallback: true,
        exchanges: [{ role: 'user', text: 'go', blocks: [{ prose: 'go' }] }]
      })
    );
    const thread = p.window.document.getElementById('thread');
    const note = thread?.querySelector('.sourced');
    assert.ok(note, 'expected a note that this thread was parsed rather than witnessed');
    // Above the oldest turn, like the cut notice, because it is about the whole
    // thread rather than about any one turn in it.
    assert.equal(thread?.firstElementChild, note);
    // Names no surface of ours \u2014 the glossary rule in the root AGENTS.md.
    assert.doesNotMatch(note.textContent ?? '', /\b(dock|board|panel|card|sheet)\b/i);
  });

  it('says nothing about the source when it is drawing what it witnessed', (t) => {
    const p = openThread(
      t,
      threadView({ exchanges: [{ role: 'user', text: 'go', blocks: [{ prose: 'go' }] }] })
    );
    assert.equal(p.window.document.querySelector('#thread .sourced'), null);
  });

  it('says nothing about the source when nothing has been said', (t) => {
    // A wire `reconstructed` no longer produces, pinned here because the dock
    // declines it on its own: the note would claim a reconstruction of a
    // conversation nobody has had, and stand where the empty notice belongs.
    const p = openThread(t, threadView({ fallback: true, exchanges: [] }));
    const thread = p.window.document.getElementById('thread');
    assert.equal(thread?.querySelector('.sourced'), null);
    assert.ok(thread?.querySelector('.empty'), 'expected the no-conversation notice');
  });

  it('still names the source when the cut notice is all that stands', (t) => {
    // A tail that is all tool results: no turns, but the session has said
    // plenty and the reader is being told so out of the very file the note is
    // about.
    const p = openThread(t, threadView({ fallback: true, truncated: true, exchanges: [] }));
    const thread = p.window.document.getElementById('thread');
    assert.ok(thread?.querySelector('.elided'));
    assert.ok(thread?.querySelector('.sourced'));
  });

  it('puts the cut notice above the source note, oldest fact first', (t) => {
    // Both can be true at once: the fallback reader is the one that tails.
    const p = openThread(
      t,
      threadView({
        fallback: true,
        truncated: true,
        exchanges: [{ role: 'user', text: 'go', blocks: [{ prose: 'go' }] }]
      })
    );
    const thread = p.window.document.getElementById('thread');
    assert.ok(thread?.querySelector('.elided'));
    assert.ok(thread?.querySelector('.sourced'));
    assert.equal(thread?.firstElementChild?.className, 'elided');
  });

  it('says nothing about a cut when the whole conversation is there', (t) => {
    const p = openThread(
      t,
      threadView({ exchanges: [{ role: 'user', text: 'go', blocks: [{ prose: 'go' }] }] })
    );
    assert.equal(p.window.document.querySelector('#thread .elided'), null);
  });

  it('prefers the cut notice over claiming no conversation was found', (t) => {
    // A tail that is all tool results yields no turns, but the session has said
    // plenty — "no conversation" would be a lie the terminal disproves.
    const p = openThread(t, threadView({ truncated: true, exchanges: [] }));
    assert.ok(p.window.document.querySelector('#thread .elided'));
    assert.equal(p.window.document.querySelector('#thread .empty'), null);
  });

  it('keeps the cut notice out of the way of a repaint', (t) => {
    const p = openThread(
      t,
      threadView({
        truncated: true,
        exchanges: [{ role: 'user', text: 'go', blocks: [{ prose: 'go' }] }]
      })
    );
    const first = p.window.document.querySelector('#thread .elided');
    assert.ok(first, 'expected the notice before the repaint');
    const thread = threadView({
      truncated: true,
      exchanges: [
        { role: 'user', text: 'go', blocks: [{ prose: 'go' }] },
        { role: 'assistant', text: 'done', blocks: [{ html: '<p>done</p>' }] }
      ]
    });
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: thread.pid })] })], { thread }));
    // The unchanged head is left standing: the notice is not rebuilt under it.
    assert.equal(p.window.document.querySelector('#thread .elided'), first);
    assert.equal(p.window.document.querySelectorAll('#thread .turn').length, 2);
  });
});
