import { ticketSourceView } from '../ticket_fixtures';
import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import {
  assertedMessageBody,
  askRequest,
  cardView,
  composerTarget,
  composerValue,
  escape,
  groupView,
  openPanel,
  openThread,
  permissionRequest,
  questionView,
  stateMessage,
  threadView,
  typeIn,
  Panel
} from '../harness';

describe('Escape in the dock', () => {
  it('interrupts on Escape in the composer', (t) => {
    const p = openThread(t, threadView({ pid: 7, status: 'busy' }));
    typeIn(p, 'Keep this draft');
    const input = composerTarget(p);
    input.focus();
    escape(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'interrupt', pid: 7 });
    assert.equal(p.posted.filter((m) => m.type === 'interrupt').length, 1);
    assert.equal(composerValue(p), 'Keep this draft');
    assert.equal(p.window.document.activeElement, input);
  });

  it('interrupts on Escape for a session another window drives', (t) => {
    // `owned` covers a piped session wherever it runs — a promoted record from
    // another window carries it too — and the host routes that pid to its own
    // window. The key must not be gated tighter than the button beside it.
    const p = openThread(
      t,
      threadView({ pid: 7, status: 'waiting', owned: true, pending: [permissionRequest()] })
    );
    escape(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'interrupt', pid: 7 });
  });

  it('takes no Escape when there is no turn to end', (t) => {
    // The key is the head button's other door, so it is off exactly when the
    // button is — an idle session's draft is not something Escape may touch.
    const p = openThread(t, threadView({ pid: 7, status: 'idle' }));
    escape(p);
    assert.equal(
      p.posted.some((m) => m.type === 'interrupt'),
      false
    );
  });

  it('takes no Escape between our write and the CLI opening the turn', (t) => {
    const p = openThread(t, threadView({ pid: 7, status: 'busy', turnPending: true }));
    escape(p);
    assert.equal(
      p.posted.some((m) => m.type === 'interrupt'),
      false
    );
  });

  describe('Escape with the caret outside the composer', () => {
    /** A real keydown: cancelable, so a surface that takes it can say so. */
    const press = (p: Panel, at: Element | null): void => {
      at?.dispatchEvent(
        new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    };
    const interrupts = (p: Panel): number => p.posted.filter((m) => m.type === 'interrupt').length;

    /** A busy session selected on a board whose group carries `over`. */
    const busy = (t: TestContext, over: Partial<Parameters<typeof groupView>[0]> = {}): Panel => {
      const thread = threadView({ pid: 7, status: 'busy' });
      const groups = [
        groupView({ sessions: [cardView({ pid: 7, startedAt: thread.startedAt })], ...over })
      ];
      const p = openPanel(t);
      p.push(stateMessage(groups));
      p.window.document.querySelector<HTMLElement>('.card')?.click();
      p.push(stateMessage(groups, { thread }));
      return p;
    };

    it('interrupts from the turn stream', (t) => {
      const p = busy(t);
      press(p, p.window.document.getElementById('thread'));
      assert.equal(interrupts(p), 1);
      assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'interrupt', pid: 7 });
    });

    it('interrupts with nothing focused', (t) => {
      const p = busy(t);
      press(p, p.window.document.body);
      assert.equal(interrupts(p), 1);
    });

    it('takes no Escape when there is no turn to end', (t) => {
      const p = openThread(t, threadView({ pid: 7, status: 'idle' }));
      press(p, p.window.document.body);
      assert.equal(interrupts(p), 0);
    });

    it('keeps chat interruption available while Tickets occupies the board', (t) => {
      const p = busy(t);
      p.push(
        stateMessage([groupView()], { ticketSource: { ...ticketSourceView(), linked: true } })
      );
      p.window.document.getElementById('board-tickets')?.click();
      press(p, p.window.document.body);
      assert.equal(interrupts(p), 1, 'the visible chat lost its interrupt');
      p.window.document.getElementById('board-sessions')?.click();
      press(p, p.window.document.body);
      assert.equal(interrupts(p), 2, 'Sessions also leaves chat interruption available');
    });

    it('leaves Escape to a field of its own', (t) => {
      // A box that never heard of Escape is still somewhere a reader is typing,
      // and the key there is not a reach for the session.
      const p = busy(t);
      const field = p.window.document.createElement('input');
      p.window.document.getElementById('chat')?.append(field);
      press(p, field);
      assert.equal(interrupts(p), 0);
    });

    it('leaves Escape to an editor of its own', (t) => {
      // The composer is an editor too, so its own key is told apart by where
      // it came from, not by being editable.
      const p = busy(t);
      const box = p.window.document.createElement('div');
      box.setAttribute('contenteditable', 'true');
      const line = p.window.document.createElement('p');
      box.append(line);
      p.window.document.getElementById('chat')?.append(box);
      press(p, line);
      assert.equal(interrupts(p), 0);
    });

    it('leaves Escape to the resume picker over the board', (t) => {
      const p = busy(t);
      p.window.document.querySelector<HTMLElement>('.card.add .half[data-act="resume"]')?.click();
      const picker = p.window.document.getElementById('picker');
      assert.equal(picker?.hidden, false, 'the picker did not open');
      press(p, picker);
      assert.equal(picker?.hidden, true);
      assert.equal(interrupts(p), 0, 'one Escape closed the picker and ended the turn');
      // The control: with the picker gone the same key is the interrupt again,
      // so the zero above was the picker's doing and not a session gone idle.
      press(p, p.window.document.body);
      assert.equal(interrupts(p), 1);
    });

    it('leaves Escape to the servers sheet over the board', (t) => {
      const p = busy(t, {
        servers: [
          {
            branch: 'side',
            tree: '/Users/someone/proj',
            cwd: '/Users/someone/proj',
            runnerId: 'dev',
            label: 'npm run dev'
          }
        ]
      });
      p.window.document.querySelector<HTMLElement>('.sdoor')?.click();
      const sheet = p.window.document.getElementById('runsheet');
      assert.equal(sheet?.hidden, false, 'the sheet did not open');
      press(p, sheet);
      assert.equal(sheet?.hidden, true);
      assert.equal(interrupts(p), 0, 'one Escape closed the sheet and ended the turn');
      press(p, p.window.document.body);
      assert.equal(interrupts(p), 1);
    });

    it('leaves Escape to an open dialog', (t) => {
      const thread = threadView({
        pid: 7,
        status: 'busy',
        pending: [askRequest({ questions: [questionView()] })]
      });
      const p = openThread(t, thread);
      p.window.document.getElementById('qlaunch')?.click();
      const ask = p.window.document.getElementById('ask');
      assert.equal(ask?.hidden, false, 'the dialog did not open');
      press(p, p.window.document.getElementById('question'));
      assert.equal(ask?.hidden, true);
      assert.equal(interrupts(p), 0, 'one Escape closed the dialog and ended the turn');
      press(p, p.window.document.body);
      assert.equal(interrupts(p), 1);
    });
  });
});
