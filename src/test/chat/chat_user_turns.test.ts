import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cardView,
  composerProse,
  enter,
  formatButton,
  FOUR_LINES,
  groupView,
  openPanel,
  openThread,
  stateMessage,
  threadView,
  importComposer,
  typeIn
} from '../harness';
import { openQueued, outboxBody, settledTurn, userTurnBody } from './chat_helpers';

/** One fence of four lines, an empty one among them: what the composer's Code
 *  block makes of four paragraphs (`TASK_done_composer_formatting.md`). */
const FENCE = '```\nalpha\nbeta\n\ngamma\n```';

/** Every `pre` in a row's body, as its lines. */
const blocksIn = (body: Element | null | undefined): string[] =>
  [...(body?.querySelectorAll('pre') ?? [])].map((pre) =>
    (pre.textContent ?? '').replace(/\n$/, '')
  );

describe('a turn someone sent', () => {
  describe('one code block of several lines', () => {
    it('is one block in a queued row', (t) => {
      assert.deepEqual(blocksIn(outboxBody(openQueued(t, FENCE))), ['alpha\nbeta\n\ngamma']);
    });

    it('is one block in a settled turn', (t) => {
      const p = openThread(t, threadView({ exchanges: [settledTurn(FENCE)] }));
      assert.deepEqual(blocksIn(userTurnBody(p)), ['alpha\nbeta\n\ngamma']);
    });

    it('made from four lines in the composer, is one block in its echo', (t) => {
      const p = openThread(t, threadView({ status: 'busy' }));
      const box = composerProse(p);
      box.restore(FOUR_LINES, { history: 'fresh' });
      box.select(1, 21);
      formatButton(p, 'codeBlock').click();
      enter(p);
      const body = p.window.document.querySelector('#thread .turn.sending .body');
      assert.deepEqual(blocksIn(body), ['alpha\nbeta\n\ngamma']);
    });
  });

  describe('an in-flight row', () => {
    it('shows a queued bold mark as bold', (t) => {
      const body = outboxBody(openQueued(t, 'see **x** now'));
      assert.equal(body?.querySelector('strong')?.textContent, 'x');
      assert.equal(body?.textContent, 'see x now');
    });

    it('shows a queued list as a list', (t) => {
      const body = outboxBody(openQueued(t, '- one\n- two'));
      assert.equal(body?.querySelector('.raw'), null);
      assert.deepEqual(
        [...(body?.querySelectorAll('li') ?? [])].map((item) => item.textContent),
        ['one', 'two']
      );
      assert.equal(body?.querySelector('ul, ol')?.tagName, 'UL');
    });

    it('shows an echoed bold mark as bold', (t) => {
      const p = openThread(t, threadView({ status: 'busy' }));
      importComposer(p, 'see **x** now');
      enter(p);
      const body = p.window.document.querySelector('#thread .turn.sending .body');
      assert.equal(body?.querySelector('strong')?.textContent, 'x');
      assert.equal(body?.textContent, 'see x now');
    });

    it('shows a refused send’s bold mark as bold', (t) => {
      // A refusal restores into an empty box, so the row is drawn only once
      // the reader has typed something else (`settleSend`).
      const p = openThread(t, threadView({ startedAt: 1_000 }));
      importComposer(p, 'see **x** now');
      enter(p);
      const sent = p.posted.find((message) => message.type === 'send');
      assert.ok(sent?.type === 'send');
      typeIn(p, 'still writing');
      p.push({
        type: 'sendResult',
        pid: sent.pid,
        startedAt: sent.startedAt,
        operationId: sent.operationId,
        ok: false,
        reason: 'no'
      });
      const body = p.window.document.querySelector('#thread .send-failed .body');
      assert.equal(body?.querySelector('strong')?.textContent, 'x');
      assert.equal(body?.textContent, 'see x now');
    });

    it('redraws a queued row when its text changes', (t) => {
      const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
      const p = openPanel(t);
      p.push(stateMessage(groups));
      p.window.document.querySelector<HTMLElement>('.card')?.click();
      const row = (text: string) => threadView({ status: 'busy', queued: [{ id: 'q1', text }] });
      p.push(stateMessage(groups, { thread: row('see **x**') }));
      assert.equal(p.window.document.querySelector('#thread .outbox strong')?.textContent, 'x');
      p.push(stateMessage(groups, { thread: row('see **y**') }));
      assert.equal(p.window.document.querySelector('#thread .outbox strong')?.textContent, 'y');
    });
  });

  describe('a settled turn of the reader’s', () => {
    it('shows a bold mark as bold', (t) => {
      const p = openThread(t, threadView({ exchanges: [settledTurn('see **x** now')] }));
      assert.equal(userTurnBody(p)?.querySelector('strong')?.textContent, 'x');
      assert.equal(userTurnBody(p)?.textContent, 'see x now');
    });

    it('shows a list as a list', (t) => {
      const p = openThread(t, threadView({ exchanges: [settledTurn('- one\n- two')] }));
      assert.equal(userTurnBody(p)?.querySelector('ul, ol')?.tagName, 'UL');
      assert.deepEqual(
        [...(userTurnBody(p)?.querySelectorAll('li') ?? [])].map((item) => item.textContent),
        ['one', 'two']
      );
    });

    it('keeps image syntax a person typed as text', (t) => {
      // The image rule is off in the prose parser, so `![a](b)` is words, as
      // it was when this turn was drawn as typed: no `<img>`, nothing dropped.
      const typed = 'why does ![render](/tmp/u.png) not work?';
      const p = openThread(t, threadView({ exchanges: [settledTurn(typed)] }));
      assert.equal(userTurnBody(p)?.querySelector('img'), null);
      assert.equal(userTurnBody(p)?.textContent, typed);
    });

    it('renders a peer’s turn, also role user, the same way', (t) => {
      const p = openThread(
        t,
        threadView({ exchanges: [settledTurn('take **the** review', 'sess-a1b2c3d4')] })
      );
      const peer = p.window.document.querySelector('#thread .turn.user.peer .body');
      assert.equal(peer?.querySelector('strong')?.textContent, 'the');
      assert.equal(peer?.textContent, 'take the review');
    });
  });

  describe('a message another session sent', () => {
    const peer = () =>
      threadView({
        exchanges: [
          { role: 'user', text: 'mine', blocks: [{ prose: 'mine' }] },
          {
            role: 'user',
            from: 'sess-a1b2c3d4-and-more',
            text: 'take the review',
            blocks: [{ prose: 'take the review' }]
          }
        ]
      });

    it('marks the turn as a peer’s rather than the reader’s own', (t) => {
      const turns = openThread(t, peer()).window.document.querySelectorAll('#thread .turn');
      assert.equal(turns.length, 2);
      assert.equal(turns[0]?.querySelector('.who')?.textContent, 'you');
      const who = turns[1]?.querySelector('.who');
      assert.match(who?.textContent ?? '', /^peer/);
      assert.equal(who?.querySelector('.attr')?.textContent, 'sess-a1b');
    });

    it('is still a user turn, and still says what arrived', (t) => {
      const turns = openThread(t, peer()).window.document.querySelectorAll('#thread .turn');
      assert.equal(turns[1]?.classList.contains('user'), true);
      assert.equal(turns[1]?.classList.contains('peer'), true);
      assert.match(turns[1]?.textContent ?? '', /take the review/);
    });

    it('leaves an ordinary user turn unmarked', (t) => {
      const doc = openThread(
        t,
        threadView({
          exchanges: [{ role: 'user', text: 'mine', blocks: [{ prose: 'mine' }] }]
        })
      ).window.document;
      assert.equal(doc.querySelector('#thread .turn')?.classList.contains('peer'), false);
      assert.equal(doc.querySelector('#thread .turn .who')?.textContent, 'you');
    });
  });

  describe('a wait converging', () => {
    const said = 'All 2 sessions you were waiting on have finished.';
    const converged = () =>
      threadView({
        who: 'claude',
        exchanges: [
          { role: 'user', text: 'go and review those two', blocks: [{ prose: 'go' }] },
          { role: 'wait', text: said, blocks: [{ html: `<p>${said}</p>` }] }
        ]
      });

    it('names the feature that produced it, not the surface that drew it', (t) => {
      // `wait` is the word the agent typed. `panel`, `board` and `dock` are
      // forbidden by the glossary rule, and the model's own name would claim
      // the session said this about itself.
      const turns = openThread(t, converged()).window.document.querySelectorAll('#thread .turn');
      assert.equal(turns.length, 2);
      assert.equal(turns[1]?.querySelector('.who')?.textContent, 'wait');
    });

    it('carries no id crumb beside the word', (t) => {
      // The id it would carry is the window's, which matches no
      // `squadron-list` row — and the members are already in the body.
      const turns = openThread(t, converged()).window.document.querySelectorAll('#thread .turn');
      assert.equal(turns[1]?.querySelector('.who .attr'), null);
      assert.match(turns[1]?.textContent ?? '', /2 sessions/);
    });

    it('is drawn as neither a peer nor the reader’s own', (t) => {
      const turns = openThread(t, converged()).window.document.querySelectorAll('#thread .turn');
      const turn = turns[1];
      assert.equal(turn?.classList.contains('wait'), true);
      assert.equal(turn?.classList.contains('peer'), false);
      assert.equal(turn?.classList.contains('user'), false);
    });
  });

  it('draws a batch of identical sends as one turn each', (t) => {
    // Three messages typed at a busy session arrive as three exchanges with the
    // same text, so they carry the same turn key. The thread reconciles by
    // position, not by key — this is what says so out loud.
    const same = { role: 'user' as const, text: 'again', blocks: [{ prose: 'again' }] };
    const p = openThread(t, threadView({ exchanges: [same, same, same] }));
    const turns = p.window.document.querySelectorAll('#thread .turn.user');
    assert.equal(turns.length, 3);
    assert.ok([...turns].every((x) => x.querySelector('.who')?.textContent === 'you'));
  });

  it('collapses a skill to a chip carrying its name', (t) => {
    // A skill body is hundreds of lines of instruction nobody typed. The thread
    // says one loaded and which; the words themselves belong to the file.
    const p = openThread(
      t,
      threadView({
        exchanges: [
          { role: 'user', text: '/simplify', blocks: [{ prose: '/simplify' }] },
          { mark: 'skill', skill: 'simplify' },
          { role: 'assistant', text: 'four agents', blocks: [{ html: '<p>four agents</p>' }] }
        ]
      })
    );
    const chip = p.window.document.querySelector('#thread .turn.skill');
    assert.equal(chip?.querySelector('.cmd')?.textContent, 'skill · simplify');
    assert.equal(chip?.querySelector('.who'), null, 'a chip claimed an author');
    assert.equal(chip?.querySelector('.body'), null, 'a chip carried a body');
  });

  it('shows a skill the reader typed in their own voice', (t) => {
    // A slash command is never a turn in the transcript, so this chip is the
    // only record that anybody asked for the run that follows it.
    const p = openThread(
      t,
      threadView({
        exchanges: [
          { mark: 'skill', skill: 'simplify', by: 'you' },
          { mark: 'skill', skill: 'ponytail', by: 'agent' }
        ]
      })
    );
    const [mine, theirs] = p.window.document.querySelectorAll('#thread .turn.skill');
    assert.equal(mine?.querySelector('.who')?.textContent, 'you');
    assert.equal(mine?.querySelector('.cmd')?.textContent, '/simplify');
    assert.equal(theirs?.querySelector('.who'), null, 'the session’s own skill claimed an author');
    assert.equal(theirs?.querySelector('.cmd')?.textContent, 'skill · ponytail');
  });

  it('keeps a skill chip off the prompt bar', (t) => {
    // The bar walks `.turn.user`. A skill body used to be one, so ↑ landed the
    // reader inside injected instruction they never wrote.
    const p = openThread(
      t,
      threadView({
        exchanges: [
          { role: 'user', text: 'do it', blocks: [{ prose: 'do it' }] },
          { mark: 'skill', skill: 'ponytail' },
          { mark: 'break' }
        ]
      })
    );
    assert.equal(p.window.document.querySelectorAll('#thread .turn.user').length, 1);
  });
});
