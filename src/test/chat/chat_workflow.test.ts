import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  answerSend,
  assertedMessageBody,
  attachWorkflow,
  cardView,
  enter,
  groupView,
  openPanel,
  openThread,
  stateMessage,
  unreachableThread,
  threadView,
  workflowView,
  Panel,
  composerValue,
  importComposer
} from '../harness';

describe('the composer’s workflow mention', () => {
  const WORKFLOWS = [
    workflowView({ id: 'ship', label: 'plan→build→review' }),
    workflowView({
      id: 'spike',
      label: 'spike→report',
      steps: [{ id: 'spike', label: 'Spike', prompt: 'spike it' }]
    })
  ];

  /**
   * The board these scenarios push, built once and re-pushed rather than rebuilt.
   *
   * `startedAt` is pinned, and that is load-bearing: `main.ts` sweeps a
   * composer's drafts when a pid reports a *different* start, since that is a
   * recycled number rather than a session that went quiet. `cardView` defaults
   * its start to `Date.now()`, so a fixture that rebuilds the card between pushes
   * is a new session as far as the panel is concerned — and a scenario asserting
   * a mention is gone would pass on the sweep rather than on what it is named
   * for.
   */
  const GROUPS = [groupView({ sessions: [cardView({ pid: 101, startedAt: 5_000 })] })];
  const sessionThread = (over: Parameters<typeof threadView>[0] = {}) =>
    threadView({ startedAt: 5_000, ...over });

  /** A thread whose panel has workflows on it — the machine that authored some. */
  const mentioning = (t: Parameters<typeof openThread>[0]): Panel => {
    const p = openPanel(t);
    p.push(stateMessage(GROUPS, { workflows: WORKFLOWS }));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(
      stateMessage(GROUPS, { thread: sessionThread({ status: 'idle' }), workflows: WORKFLOWS })
    );
    return p;
  };

  /** Open the sheet from the composer's door and press the row it draws. */
  const attach = attachWorkflow;

  const chip = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#wattach .wflow');

  it('is something to send on its own, so the button offers it', (t) => {
    // A workflow alone is a message — the line the host composes from it says
    // everything the session needs — so arming one fills an empty composer,
    // and dropping it empties it again.
    const p = mentioning(t);
    const send = p.window.document.getElementById('send') as HTMLButtonElement;
    assert.equal(send.disabled, true);
    attach(p, 'plan→build→review');
    assert.equal(send.disabled, false, 'an armed workflow was not something to send');
    p.window.document.querySelector<HTMLElement>('#wattach .wflow .drop')?.click();
    assert.equal(send.disabled, true);
  });

  it('offers no send for a mention a live run has superseded', (t) => {
    // Live provenance owns the slot, so a mention left in the map is not
    // something the next send would carry — and the button must not say it is.
    const p = mentioning(t);
    attach(p, 'plan→build→review');
    p.push(
      stateMessage(GROUPS, {
        thread: sessionThread({ status: 'idle', workflow: { label: 'plan→build→review' } }),
        workflows: WORKFLOWS
      })
    );
    assert.equal((p.window.document.getElementById('send') as HTMLButtonElement).disabled, true);
  });

  it('still offers Attach when no workflow exists, for New workflow…', (t) => {
    // Surfaces PRD Phase A: the first file is authored from the composer, so
    // empty is not "no chrome". The run bar stays as + New for the same reason.
    const p = openThread(t, threadView({ status: 'idle' }));
    assert.ok(p.window.document.querySelector('#wattach .fpill'));
  });

  it('lists every workflow off the pill, without opening the sheet', (t) => {
    const p = mentioning(t);
    p.window.document.querySelector<HTMLElement>('#wattach .fpill')?.click();
    const rows = [...p.window.document.querySelectorAll<HTMLElement>('#wattach .fmenu .mitem')];
    assert.deepEqual(
      rows.map((r) => r.querySelector('.nm')?.textContent),
      ['plan→build→review', 'spike→report']
    );
    assert.deepEqual(
      rows.map((r) => r.querySelector('.sub')?.textContent),
      ['3 steps', '1 step'],
      'the row says what it is, not only what it is called'
    );
    assert.ok(
      p.window.document.getElementById('bottomdrawer')?.hidden,
      'the composer opened the whole sheet for a pick'
    );
  });

  it('arms the workflow the row names, and shuts the menu behind it', (t) => {
    const p = mentioning(t);
    p.window.document.querySelector<HTMLElement>('#wattach .fpill')?.click();
    [...p.window.document.querySelectorAll<HTMLElement>('#wattach .fmenu .mitem')]
      .find((r) => (r.textContent ?? '').includes('spike→report'))
      ?.click();
    assert.match(chip(p)?.textContent ?? '', /spike→report/);
    assert.equal(
      p.window.document.querySelector('#wattach .fmenu .mitem'),
      null,
      'the menu stayed up over the chip it just armed'
    );
  });

  it('carries New workflow… under the list, on an empty machine too', (t) => {
    // The one thing the sheet refuses to do (S8), which is why New is here.
    const p = openThread(t, threadView({ status: 'idle' }));
    p.window.document.querySelector<HTMLElement>('#wattach .fpill')?.click();
    const foot = p.window.document.querySelector<HTMLElement>('#wattach .fmenu .faction');
    assert.match(foot?.textContent ?? '', /New workflow/);
    foot?.click();
    assert.equal(p.window.document.getElementById('wfeditor')?.hidden, false, 'New drew no editor');
    assert.ok(p.window.document.getElementById('bottomdrawer')?.hidden, 'and no sheet');
  });

  it('draws the mention as a named artifact once one is attached', (t) => {
    const p = mentioning(t);
    attach(p, 'plan→build→review');
    assert.match(chip(p)?.textContent ?? '', /plan→build→review/);
    assert.match(chip(p)?.textContent ?? '', /3 steps/);
    assert.equal(
      p.window.document.querySelector('#wattach .fpill'),
      null,
      'armed alone — no Attach sibling'
    );
    assert.equal(p.posted.at(-1)?.type, 'select', 'attaching posted to the host');
    p.window.document.querySelector<HTMLElement>('#wattach .drop')?.click();
    assert.ok(p.window.document.querySelector('#wattach .fpill'), 'Attach returns after ×');
  });

  it('peeks the process before the send, and does not run it', (t) => {
    // A6: you approve a process, not a filename. The caret is the whole of it.
    const p = mentioning(t);
    attach(p, 'plan→build→review');
    p.window.document.querySelector<HTMLElement>('#wattach .peek')?.click();
    const steps = [...p.window.document.querySelectorAll('#wattach .wstep')].map(
      (s) => s.textContent
    );
    assert.deepEqual(steps, ['Plan', 'Build', 'Review']);
  });

  it('removes the mention without touching what was typed', (t) => {
    const p = mentioning(t);
    importComposer(p, 'harden option B');
    attach(p, 'plan→build→review');
    p.window.document.querySelector<HTMLElement>('#wattach .drop')?.click();
    assert.equal(chip(p), null);
    assert.equal(composerValue(p), 'harden option B', 'removing the mention ate the draft');
  });

  it('sends the mention with the message, and clears it', (t) => {
    const p = mentioning(t);
    importComposer(p, 'harden option B');
    attach(p, 'plan→build→review');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'harden option B',
      workflowId: 'ship'
    });
    // Q12's one-shot: a mention rides *this* send, and the next free-text
    // message must not re-attach the process.
    assert.equal(chip(p), null);
    importComposer(p, 'and now something else');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'and now something else'
    });
  });

  it('is a message on its own, with an empty box', (t) => {
    // Exactly as a pasted image with no prose is: the mention says everything.
    const p = mentioning(t);
    attach(p, 'spike→report');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: '',
      workflowId: 'spike'
    });
  });

  it('leaves an ordinary send exactly as it was', (t) => {
    const p = mentioning(t);
    importComposer(p, 'no workflow here');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'no workflow here'
    });
  });

  /**
   * What `enrich` puts on the wire: the workflow line, and the typed subject
   * beneath it. The subject is a *suffix* of it — which is the whole reason the
   * echo has to be told what was delivered rather than assume what was typed.
   */
  const wire = (subject: string): string => {
    const line = 'Following the workflow "plan→build→review" (ship).';
    return subject ? `${line}\n\n${subject}` : line;
  };

  /** The thread coming back with the turn the CLI actually wrote down. */
  const echoed = (p: Panel, text: string): void =>
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101, startedAt: 5_000 })] })], {
        thread: sessionThread({
          status: 'busy',
          exchanges: [{ role: 'user', text, blocks: [{ prose: text }] }]
        }),
        workflows: WORKFLOWS
      })
    );

  it('settles the echo against the enriched turn, not the subject typed', (t) => {
    const p = mentioning(t);
    importComposer(p, 'harden option B');
    attach(p, 'plan→build→review');
    enter(p);
    assert.ok(p.window.document.querySelector('#thread .turn.sending'), 'no echo was shown');

    // The host says what it delivered on the accept, and the CLI writes that
    // same text down a poll later.
    answerSend(p, { ok: true, text: wire('harden option B') });
    echoed(p, wire('harden option B'));

    assert.equal(
      p.window.document.querySelector('#thread .turn.sending'),
      null,
      'the echo outlived the turn the CLI wrote down'
    );
    assert.equal(
      p.window.document.querySelectorAll('#thread .turn.user').length,
      1,
      'the dock drew the message twice'
    );
  });

  it('settles the echo of a mention sent with an empty box', (t) => {
    // The branch's own case: a workflow on its own is the message, so the echo
    // holds nothing at all — and an empty `you` bubble that never settles is
    // what an unenriched echo leaves standing for the whole turn.
    const p = mentioning(t);
    attach(p, 'plan→build→review');
    enter(p);
    assert.ok(p.window.document.querySelector('#thread .turn.sending'), 'no echo was shown');

    answerSend(p, { ok: true, text: wire('') });
    echoed(p, wire(''));

    assert.equal(
      p.window.document.querySelector('#thread .turn.sending'),
      null,
      'the empty echo outlived the turn it stood for'
    );
    assert.equal(p.window.document.querySelectorAll('#thread .turn.user').length, 1);
  });

  it('hands the mention back when the send was refused', (t) => {
    // The failure this is for is the host's arm refusal: an unknown slash name, or a session
    // in somebody's shell. Losing the chip there makes the reader re-attach the
    // very thing that was just refused.
    const p = mentioning(t);
    importComposer(p, 'go');
    attach(p, 'plan→build→review');
    enter(p);
    answerSend(p, { ok: false, reason: 'ship: /nope is not a command' });
    assert.equal(composerValue(p), 'go');
    assert.match(chip(p)?.textContent ?? '', /plan→build→review/);
    assert.match(
      p.window.document.getElementById('blocked')?.textContent ?? '',
      /is not a command/
    );
  });

  it('drops a mention whose workflow has left the machine', (t) => {
    // The bar disarms itself for this reason, and a chip has the same problem: a
    // send naming a workflow that is gone is refused for a cause nobody can see.
    const p = mentioning(t);
    attach(p, 'plan→build→review');
    p.push(
      stateMessage(GROUPS, {
        thread: sessionThread({ status: 'idle' }),
        workflows: [WORKFLOWS[1] as WorkflowView]
      })
    );
    assert.equal(chip(p), null);
    // And the send says so: the chip is drawn from the state, so its absence
    // proves nothing on its own — an undeleted mention would be invisible here
    // and still ride every message this session sends.
    importComposer(p, 'carry on');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'carry on'
    });
  });

  it('drops the mention when every workflow goes, not just the chip', (t) => {
    // `readWorkflows` answers an empty list to any failed readdir, so this is one
    // bad poll rather than a deleted directory — and a mention that outlived its
    // chip is invisible, unremovable, and refuses every send that session makes.
    const p = mentioning(t);
    attach(p, 'plan→build→review');
    p.push(
      stateMessage(GROUPS, {
        thread: sessionThread({ status: 'idle' })
      })
    );
    importComposer(p, 'still here');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'still here'
    });
  });

  it('drops a departed workflow while its own menu is held open', (t) => {
    // `renderMention` returns early to keep the trigger a click is running on
    // still. That guard must not also keep a dead mention alive: the poll that
    // drops the workflow is exactly as likely to land while the menu is up, and
    // a mention that outlives it refuses every send until the menu is closed.
    const p = mentioning(t);
    attach(p, 'plan→build→review');
    p.window.document.querySelector<HTMLElement>('#wattach .fpill')?.click();
    p.push(
      stateMessage(GROUPS, {
        thread: sessionThread({ status: 'idle' }),
        workflows: [WORKFLOWS[1] as WorkflowView]
      })
    );
    importComposer(p, 'carry on');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'carry on'
    });
  });

  it('forgets a recycled pid’s mention, so the new session cannot inherit it', (t) => {
    // The composer's drafts are keyed by pid alone, and the process table
    // recycles those. A different `startedAt` under the same number is a new
    // session, and it is the only reading of "gone" that is safe to act on.
    const p = mentioning(t);
    attach(p, 'plan→build→review');
    const reborn = [groupView({ sessions: [cardView({ pid: 101, startedAt: 11_000 })] })];
    p.push(
      stateMessage(reborn, {
        thread: threadView({ startedAt: 11_000, status: 'idle' }),
        workflows: WORKFLOWS
      })
    );
    importComposer(p, 'who are you');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'who are you'
    });
  });

  it('keeps the mention through a poll that lost the whole board', (t) => {
    // `discover` answers an empty list to a failed `readdir` and `scanProcesses`
    // to a failed `ps` — `scan.ts` refuses to cache that answer for exactly this
    // reason. A board that blanks repaints; a mention swept on absence would not
    // come back, and neither would what was typed beside it.
    const p = mentioning(t);
    attach(p, 'plan→build→review');
    importComposer(p, 'still mine');
    p.push(stateMessage([], { workflows: WORKFLOWS }));

    // The same session, back on the next poll — same pid, same start.
    p.push(stateMessage(GROUPS, { workflows: WORKFLOWS }));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(
      stateMessage(GROUPS, { thread: sessionThread({ status: 'idle' }), workflows: WORKFLOWS })
    );
    assert.match(chip(p)?.textContent ?? '', /plan→build→review/, 'the mention was swept');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'still mine',
      workflowId: 'ship'
    });
  });

  it('keeps the mention through a cold-cache warning', (t) => {
    // The warning returns before the post, so the mention has to survive the
    // first Enter and ride the second — the one that is the confirmation.
    const p = openThread(t, threadView({ updatedAt: Date.now() - 70 * 60_000 }), {
      workflows: WORKFLOWS
    });
    importComposer(p, 'carry on');
    attach(p, 'plan→build→review');
    enter(p);
    assert.notEqual(p.posted.at(-1)?.type, 'send');
    assert.match(chip(p)?.textContent ?? '', /plan→build→review/);

    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'carry on',
      workflowId: 'ship'
    });
  });

  it('mentions on the session it was attached to, and no other', (t) => {
    const p = openPanel(t);
    const groups = [groupView({ sessions: [cardView({ pid: 101 }), cardView({ pid: 202 })] })];
    p.push(stateMessage(groups, { workflows: WORKFLOWS }));
    const card = (pid: number) =>
      [...p.window.document.querySelectorAll<HTMLElement>('.card')].find(
        (c) => c.dataset.pid === String(pid)
      );

    card(101)?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 101 }), workflows: WORKFLOWS }));
    attach(p, 'plan→build→review');

    // The other session's composer carries none of it.
    card(202)?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 202 }), workflows: WORKFLOWS }));
    assert.equal(chip(p), null);
    importComposer(p, 'unrelated');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 202,
      text: 'unrelated'
    });

    // And coming back finds the mention where it was left.
    card(101)?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 101 }), workflows: WORKFLOWS }));
    assert.match(chip(p)?.textContent ?? '', /plan→build→review/);
  });

  /**
   * The branch stays on the card. The dock does not paint it: the session card
   * already shows it, and the status line under the box is gone. No protocol
   * field changed — `ThreadView.branch` stays on the wire.
   */
  it('does not paint the branch in the dock', (t) => {
    const branch = 'feature/kettle-9f3';
    const p = openThread(t, threadView({ branch }));
    assert.equal(p.window.document.getElementById('cstatus'), null);
    assert.equal(p.window.document.getElementById('dock')?.textContent?.includes(branch), false);
  });

  /**
   * The permission mode moves into the tool row. It is a span, not a button:
   * the glyph, the label, and the tip the status line used to carry.
   */
  it('names the permission mode the session is under', (t) => {
    const p = openThread(t, threadView({ mode: { label: 'plan', holds: true, bypass: false } }));
    const mode = p.window.document.querySelector('#ctools .mode');
    assert.ok(mode);
    assert.equal(mode.tagName, 'SPAN');
    assert.equal(mode.querySelector('button'), null);
    assert.equal(mode.querySelector('.g')?.textContent, '⏸');
    assert.match(mode.textContent ?? '', /plan/);
    assert.equal(mode.classList.contains('bypass'), false);
    assert.equal(
      mode.getAttribute('data-tip'),
      'permission mode: plan · as its transcript last stated it.'
    );
  });

  /** Bypass is the one mode that is a warning, and the card already decides
   *  which sessions are in it — the span only has to carry the flag. */
  it('marks a session that is skipping permissions', (t) => {
    const p = openThread(t, threadView({ mode: { label: 'bypass', holds: false, bypass: true } }));
    const mode = p.window.document.querySelector('#ctools .mode');
    assert.ok(mode);
    assert.equal(mode.classList.contains('bypass'), true);
    assert.equal(mode.querySelector('.g')?.textContent, '⏵⏵');
    assert.match(mode.textContent ?? '', /bypass/);
  });

  /** A session whose mode nothing stated paints nothing. `CardView` documents
   *  the mode as absent rather than empty. */
  it('paints no permission mode when the thread states none', (t) => {
    const p = openThread(t, threadView({ mode: undefined }));
    assert.equal(p.window.document.querySelector('#ctools .mode'), null);
  });

  /**
   * The send row carries controls, and says nothing at all.
   *
   * It used to keep the two facts the ghost line under the placeholder cannot
   * — a held queue, and the Escape that ends a turn — and both turned out to be
   * said better one row up. `queueBlock` is pinned to the composer divider, so
   * its `N held · send when idle` is on screen at the same moment the row was
   * restating it, and with the ghost line and the button both saying `queue`
   * the word was on the composer three times over. The Escape half named a key
   * for `#chat-interrupt`, which is a visible button on the same `endable`
   * predicate. So the row is its controls, and the sentence is gone.
   */
  it('carries no sentence on the send row, only its controls', (t) => {
    const p = openThread(t, threadView({ status: 'busy', queued: [{ id: 'q1', text: 'one' }] }));
    assert.equal(
      p.window.document.getElementById('hint'),
      null,
      'the send row still carries a sentence'
    );
    // Nothing is lost with it: the block that owns the queue still reports it,
    // which is the whole reason the row does not have to.
    assert.match(
      p.window.document.querySelector('.outbox .qbar .lbl')?.textContent ?? '',
      /1 held/
    );
    // And the row still holds what it is for.
    assert.ok(p.window.document.querySelector('#hintrow .fpill.model'));
    assert.ok(p.window.document.getElementById('send'));
  });

  it('offers no attach on a composer that cannot send', (t) => {
    // Attach is only drawn for a session this panel drives (`composer.ts`), so
    // a mention here could only ever be picked and never spent.
    const p = openThread(t, unreachableThread(), { workflows: WORKFLOWS });
    assert.equal(p.window.document.querySelector('#wattach .wflow'), null);
  });
});

describe('the live workflow chip', () => {
  it('shows a live workflow chip in the composer when the thread carries provenance', (t) => {
    const p = openThread(
      t,
      threadView({
        status: 'busy',
        workflow: { label: 'plan→build→review' }
      })
    );
    const chip = p.window.document.querySelector('#wattach .wflow');
    assert.ok(chip);
    assert.ok(chip?.classList.contains('running'));
    assert.equal(chip?.querySelector('.verb')?.textContent, 'Following');
    assert.equal(chip?.querySelector('.nm')?.textContent, 'plan→build→review');
    // Seat: inside #composer (not a sibling strip). Outbox stays in the thread.
    assert.ok(p.window.document.getElementById('composer')?.contains(chip));
    assert.equal(p.window.document.getElementById('wfstrip'), null);
    assert.equal(p.window.document.querySelector('#wattach .fpill'), null, 'no Attach while live');
  });

  it('clears the live chip without provenance and keeps the outbox in the thread', (t) => {
    const p = openThread(
      t,
      threadView({
        status: 'busy',
        queued: [{ id: 'q1', text: 'held' }],
        workflow: { label: 'ship' }
      })
    );
    assert.ok(p.window.document.querySelector('#wattach .wflow.running'));
    assert.ok(p.window.document.querySelector('#thread .outbox'));

    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101 })] })], {
        thread: threadView({
          pid: 101,
          status: 'busy',
          queued: [{ id: 'q1', text: 'held' }]
        })
      })
    );
    assert.equal(p.window.document.querySelector('#wattach .wflow'), null);
    assert.ok(p.window.document.querySelector('#wattach .fpill'), 'Attach returns when empty');
    assert.ok(p.window.document.querySelector('#thread .outbox'), 'queue still in thread');
  });

  it('maps waiting to Waiting and done/failed step tones on the live chip', (t) => {
    const waiting = openThread(
      t,
      threadView({ status: 'waiting', waitingFor: 'permission', workflow: { label: 'ship' } })
    );
    const chip = waiting.window.document.querySelector('#wattach .wflow');
    assert.ok(chip?.classList.contains('waiting'));
    assert.equal(chip?.querySelector('.verb')?.textContent, 'Waiting');

    const done = openThread(
      t,
      threadView({
        status: 'idle',
        workflow: { label: 'ship', step: { label: 'Commit', tone: 'done' } }
      })
    );
    assert.ok(done.window.document.querySelector('#wattach .wflow.done'));
    assert.equal(done.window.document.querySelector('#wattach .verb')?.textContent, 'Done');

    const idle = openThread(t, threadView({ status: 'idle', workflow: { label: 'ship' } }));
    assert.ok(idle.window.document.querySelector('#wattach .wflow.running'));
    assert.equal(idle.window.document.querySelector('#wattach .verb')?.textContent, 'Following');
  });

  it('paints the live chip from phase, and waiting still outranks it', (t) => {
    const done = openThread(
      t,
      threadView({ status: 'idle', workflow: { label: 'ship', phase: 'done' } })
    );
    assert.ok(done.window.document.querySelector('#wattach .wflow.done'));
    assert.equal(done.window.document.querySelector('#wattach .verb')?.textContent, 'Done');
    assert.equal(done.window.document.querySelector('#wattach .sname'), null);

    const failed = openThread(
      t,
      threadView({ status: 'idle', workflow: { label: 'ship', phase: 'failed' } })
    );
    assert.ok(failed.window.document.querySelector('#wattach .wflow.paused'));
    assert.equal(failed.window.document.querySelector('#wattach .verb')?.textContent, 'Paused');

    // Busy is mid-step whatever the record says: the stop rule is idle-only.
    const failedBusy = openThread(
      t,
      threadView({ status: 'busy', workflow: { label: 'ship', phase: 'failed' } })
    );
    assert.equal(
      failedBusy.window.document.querySelector('#wattach .verb')?.textContent,
      'Following'
    );

    const waiting = openThread(
      t,
      threadView({
        status: 'waiting',
        waitingFor: 'permission',
        workflow: { label: 'ship', phase: 'done' }
      })
    );
    assert.ok(waiting.window.document.querySelector('#wattach .wflow.waiting'));
    assert.equal(waiting.window.document.querySelector('#wattach .verb')?.textContent, 'Waiting');
  });

  it('stays coarse when provenance has no step marker', (t) => {
    const p = openThread(t, threadView({ status: 'busy', workflow: { label: 'Ship it' } }));
    const chip = p.window.document.querySelector('#wattach .wflow');
    assert.ok(chip);
    assert.equal(chip?.querySelector('.nm')?.textContent, 'Ship it');
    assert.equal(chip?.querySelector('.sname'), null);
  });

  it('does not send a second workflowId while live provenance is on the thread', (t) => {
    // Exclusivity must hold on the wire, not only on paint: a mention left in
    // the map under the live chip (hand-off / failed-send restore) must not
    // ride Enter and supersede the FOLLOWING run.
    const groups = [groupView({ sessions: [cardView({ pid: 101, startedAt: 5_000 })] })];
    const workflows = [workflowView({ id: 'ship', label: 'plan→build→review' })];
    const p = openPanel(t);
    p.push(stateMessage(groups, { workflows }));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(
      stateMessage(groups, { thread: threadView({ startedAt: 5_000, status: 'idle' }), workflows })
    );
    attachWorkflow(p, 'plan→build→review');
    assert.ok(p.window.document.querySelector('#wattach .wflow.armed'));

    p.push(
      stateMessage(groups, {
        thread: threadView({
          startedAt: 5_000,
          status: 'busy',
          workflow: { label: 'plan→build→review' }
        }),
        workflows
      })
    );
    assert.ok(p.window.document.querySelector('#wattach .wflow.running'));
    assert.equal(p.window.document.querySelector('#wattach .fpill'), null);

    importComposer(p, 'keep following');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'keep following'
    });
  });
});
