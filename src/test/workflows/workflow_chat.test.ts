import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertedMessageBody,
  attachWorkflow,
  cardView,
  enter,
  groupView,
  attachRows,
  openPanel,
  stateMessage,
  threadView,
  workflowView,
  type Panel,
  importComposer
} from '../harness';

/**
 * End-to-end composer shelf scenario: pick among several workflows, start one,
 * watch the live chip progress, see it complete, free the slot, start another.
 *
 * Unit pieces (live chip tones, one-shot mention, exclusivity) live in
 * `chat_workflow.test.ts`. This file is the product
 * walk-through those pieces compose into — one session, two authored
 * workflows, no host, no sleep.
 *
 * The host half of the same life (enrich line on a real pipe, sticky run until
 * finish) is the owned-session case in `smoke/session.smoke.ts`. Progress markers here
 * are pushed as `ThreadView.workflow.step` the way `panel.thread` would paint
 * them after reading the progress sibling.
 */
describe('workflow UI in chat (lifecycle)', () => {
  /** Two authored processes — a menu with one row cannot prove a pick. */
  const WORKFLOWS = [
    workflowView({
      id: 'ship',
      label: 'plan→build→review',
      steps: [
        { id: 'plan', label: 'Plan', prompt: 'plan it' },
        { id: 'build', label: 'Build', prompt: 'build it' },
        { id: 'review', label: 'Review', prompt: 'review it' }
      ]
    }),
    workflowView({
      id: 'spike',
      label: 'spike→report',
      steps: [
        { id: 'spike', label: 'Spike', prompt: 'spike it' },
        { id: 'report', label: 'Report', prompt: 'write it up' }
      ]
    })
  ];

  /**
   * One board for the whole walk-through. `startedAt` is fixed so a re-push is
   * the same session — `main.ts` sweeps drafts (and mentions) when a pid's
   * start changes, which would green a "chip cleared" assert for the wrong
   * reason.
   */
  const GROUPS = [groupView({ sessions: [cardView({ pid: 101, startedAt: 5_000 })] })];

  const push = (
    p: Panel,
    thread: ReturnType<typeof threadView>,
    extra: { workflows?: typeof WORKFLOWS } = {}
  ): void => {
    p.push(
      stateMessage(GROUPS, {
        thread: { ...thread, startedAt: 5_000 },
        workflows: extra.workflows ?? WORKFLOWS
      })
    );
  };

  const open = (t: Parameters<typeof openPanel>[0]): Panel => {
    const p = openPanel(t);
    p.push(stateMessage(GROUPS, { workflows: WORKFLOWS }));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    push(p, threadView({ pid: 101, status: 'idle' }));
    return p;
  };

  const attach = attachWorkflow;

  const chip = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#wattach .wflow');

  const verb = (p: Panel): string | null | undefined =>
    chip(p)?.querySelector('.verb')?.textContent;
  const name = (p: Panel): string | null | undefined => chip(p)?.querySelector('.nm')?.textContent;
  const step = (p: Panel): string | null | undefined =>
    chip(p)?.querySelector('.sname')?.textContent;

  const wcancel = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#wattach .wcancel');
  const asking = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#wattach .wask');
  const answer = (p: Panel, label: string): void => {
    const btn = [...p.window.document.querySelectorAll<HTMLElement>('#wattach .act')].find(
      (b) => b.textContent === label
    );
    assert.ok(btn, `no “${label}” to press`);
    btn.click();
  };

  const running = threadView({
    pid: 101,
    status: 'busy',
    workflow: { label: 'plan→build→review', step: { label: 'Build', tone: 'working' } }
  });

  it('hands an armed workflow to independently published progress and updates its open rail', (t) => {
    const p = open(t);
    attach(p, 'plan→build→review');
    assert.ok(chip(p)?.classList.contains('armed'));
    const select = p.posted.find((msg) => msg.type === 'select');
    assert.ok(select?.type === 'select');
    const live: ThreadView = {
      ...running,
      startedAt: 5_000,
      workflow: {
        label: 'plan→build→review',
        phase: 'running',
        step: { label: 'Build', tone: 'working' },
        steps: [
          { id: 'plan', label: 'Plan', status: 'completed' },
          { id: 'build', label: 'Build', status: 'in_progress', current: true },
          { id: 'review', label: 'Review', status: 'pending' }
        ]
      }
    };
    const publish = (thread: ThreadView, sequence: number): void =>
      p.push({
        type: 'thread',
        selection: select.selection,
        generation: 0,
        sequence,
        thread
      });
    p.push(stateMessage(GROUPS, { workflows: WORKFLOWS }));
    publish(live, 1);
    assert.ok(chip(p)?.classList.contains('live'), 'the thread update takes over the armed slot');
    assert.equal(step(p), 'Build');
    chip(p)?.click();
    const drawer = p.window.document.getElementById('workflowoverviewdrawer');
    assert.equal(drawer?.hidden, false);
    assert.equal(drawer?.querySelector('.strow.now .slabel')?.textContent, 'Build');
    publish(
      {
        ...live,
        workflow: {
          label: 'plan→build→review',
          phase: 'running',
          step: { label: 'Review', tone: 'working' },
          steps: [
            { id: 'plan', label: 'Plan', status: 'completed' },
            { id: 'build', label: 'Build', status: 'completed' },
            { id: 'review', label: 'Review', status: 'in_progress', current: true }
          ]
        }
      },
      2
    );
    assert.equal(step(p), 'Review');
    assert.equal(drawer?.querySelector('.strow.now .slabel')?.textContent, 'Review');
    publish({ ...live, workflow: undefined }, 3);
    assert.equal(chip(p), null, 'an armed mention cannot return after the live workflow leaves');
  });

  /**
   * The × on a live chip is a question, not the act — a run at step 2 is work
   * an agent is part-way through, and one press is not enough to end it. Same
   * shape the sheet's own Delete has, for the same reason.
   */
  it('asks before cancelling a run, and posts nothing until the answer', (t) => {
    const p = open(t);
    push(p, running);

    assert.ok(chip(p), 'a working run draws its chip');
    const before = p.posted.length;
    wcancel(p)?.click();

    assert.ok(asking(p), 'the × opens the question');
    assert.equal(chip(p), null, 'the question stands where the chip was');
    assert.equal(p.posted.length, before, 'asking posts nothing');
    // The step is what makes a reader stop, so the question names it.
    assert.match(asking(p)?.textContent ?? '', /Build/);
    assert.match(asking(p)?.textContent ?? '', /plan→build→review/);
  });

  it('survives a poll while the question is up', (t) => {
    const p = open(t);
    push(p, running);
    wcancel(p)?.click();

    push(p, running);
    assert.ok(asking(p), 'a 3s push must not answer for the reader');
  });

  it('does not carry a cancel question into a recycled pid', (t) => {
    const p = open(t);
    push(p, running);
    wcancel(p)?.click();
    assert.ok(asking(p));

    const replacement = {
      ...running,
      startedAt: 20_000
    };
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101, startedAt: 20_000 })] })], {
        thread: replacement,
        workflows: WORKFLOWS
      })
    );

    assert.equal(asking(p), null);
    assert.ok(chip(p), 'the replacement session draws its own workflow');
  });

  it('rebuilds an identical workflow control for a recycled pid', (t) => {
    const p = open(t);
    const completed = threadView({
      pid: 101,
      startedAt: 5_000,
      status: 'idle',
      workflow: { label: 'plan→build→review', phase: 'done' }
    });
    push(p, completed);
    const oldControl = wcancel(p);
    assert.ok(oldControl);

    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101, startedAt: 20_000 })] })], {
        thread: { ...completed, startedAt: 20_000 },
        workflows: WORKFLOWS
      })
    );
    const replacementControl = wcancel(p);
    assert.ok(replacementControl);
    assert.notEqual(replacementControl, oldControl);
    replacementControl.click();

    const message = p.posted.at(-1);
    assert.equal(message?.type, 'cancelWorkflow');
    if (message?.type === 'cancelWorkflow') assert.equal(message.startedAt, 20_000);
  });

  it('Keep puts the chip back and posts nothing', (t) => {
    const p = open(t);
    push(p, running);
    wcancel(p)?.click();
    const before = p.posted.length;

    answer(p, 'Keep');
    assert.equal(asking(p), null);
    assert.ok(chip(p), 'the chip returns');
    assert.equal(p.posted.length, before, 'Keep posts nothing');
  });

  it('Cancel run posts cancelWorkflow for the selected session', (t) => {
    const p = open(t);
    push(p, running);
    wcancel(p)?.click();

    answer(p, 'Cancel run');
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'cancelWorkflow', pid: 101 });
    assert.equal(asking(p), null, 'the question goes on its answer');
  });

  /**
   * The chip is gone because the host stamped the run and `followingWorkflow`
   * went quiet — the webview waits to be told, it does not paint the answer it
   * hopes for.
   */
  it('frees the slot when the cancelled run leaves the wire', (t) => {
    const p = open(t);
    push(p, running);
    wcancel(p)?.click();
    answer(p, 'Cancel run');

    push(p, threadView({ pid: 101, status: 'idle' }));
    assert.equal(chip(p), null);
    assert.ok(
      p.window.document.querySelector('#wattach .fpill'),
      'Attach is back for the next workflow'
    );
  });

  /**
   * A completed run has nothing to interrupt and nothing to instruct, so its ×
   * says so and asks nothing: one press, and the slot is free for the next
   * workflow. The confirm is the toll on stopping work, and there is none here.
   */
  it('dismisses a completed run from phase, even with no step marker', (t) => {
    const p = open(t);
    push(
      p,
      threadView({
        pid: 101,
        status: 'idle',
        workflow: { label: 'plan→build→review', phase: 'done' }
      })
    );

    assert.equal(wcancel(p)?.getAttribute('aria-label'), 'Dismiss plan→build→review');
    wcancel(p)?.click();
    assert.equal(asking(p), null, 'nothing to confirm');
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'cancelWorkflow', pid: 101 });
  });

  it('offers Retry from phase, even with no failed step marker', (t) => {
    const p = open(t);
    push(
      p,
      threadView({
        pid: 101,
        status: 'idle',
        workflow: { label: 'plan→build→review', phase: 'failed' }
      })
    );
    const retry = p.window.document.querySelector<HTMLElement>('#wattach .wretry');
    assert.ok(retry, 'a failed phase offers Retry / Continue');
    assert.ok(chip(p)?.classList.contains('paused'), 'failed is not told apart from paused');
    assert.equal(verb(p), 'Paused');
  });

  const failed = threadView({
    pid: 101,
    status: 'idle',
    workflow: {
      label: 'plan→build→review',
      step: { label: 'Build', tone: 'failed' },
      steps: [
        { id: 'plan', label: 'Plan', status: 'completed' },
        { id: 'build', label: 'Build', status: 'failed', current: true },
        { id: 'review', label: 'Review', status: 'pending' }
      ]
    }
  });

  /** The other answer to a failed run: one press, no question, and the panel
   *  states nothing about the step until the agent moves it. */
  it('offers Retry on a failed run and posts it unasked', (t) => {
    const p = open(t);
    push(p, failed);

    const retry = p.window.document.querySelector<HTMLElement>('#wattach .wretry');
    assert.ok(retry, 'a failed run offers Retry / Continue');
    assert.equal(retry?.textContent, 'Retry / Continue');
    assert.equal(retry?.getAttribute('aria-label'), 'Retry or continue Build');

    retry?.click();
    assert.equal(asking(p), null, 'Retry asks nothing — it is additive');
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'retryWorkflow', pid: 101 });
    assert.ok(chip(p)?.classList.contains('paused'), 'the chip stays paused until the agent moves');
  });

  /**
   * A run that stopped mid-step, which is the only shape a failure has since
   * `squadron-step` took the cursor.
   *
   * The CLI has no failure verb: a step it cannot finish is left `in_progress`
   * and the agent stops calling. So `phase` is `running` for an abandoned step
   * and for one being worked on, and it cannot tell them apart on its own.
   * **The session's status can.** A busy session is mid-step by definition;
   * an idle one with steps left has stopped without saying so. `ui/views.ts`
   * already makes exactly that join for the card's `stalled · N of M`, and this
   * is the same rule reaching the chip.
   */
  const stalled = threadView({
    pid: 101,
    status: 'idle',
    workflow: {
      label: 'plan→build→review',
      step: { label: 'Build', tone: 'working' },
      steps: [
        { id: 'plan', label: 'Plan', status: 'completed' },
        { id: 'build', label: 'Build', status: 'in_progress', current: true },
        { id: 'review', label: 'Review', status: 'pending' }
      ]
    }
  });

  /** Not Retry alone: the commonest stop is an agent that ended its turn on a
   *  question for the reader, and nothing there failed. */
  it('offers Retry / Continue on a run that stopped mid-step, and posts it unasked', (t) => {
    const p = open(t);
    push(p, stalled);

    assert.ok(chip(p)?.classList.contains('paused'));
    assert.equal(verb(p), 'Paused', 'not Following — nobody is working on it');
    const retry = p.window.document.querySelector<HTMLElement>('#wattach .wretry');
    assert.ok(retry, 'an idle session with steps left offers Retry / Continue');
    assert.equal(retry?.textContent, 'Retry / Continue');
    assert.equal(retry?.getAttribute('aria-label'), 'Retry or continue Build');

    retry?.click();
    assert.equal(asking(p), null, 'Retry asks nothing — it is additive');
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'retryWorkflow', pid: 101 });
  });

  /** The discriminator, stated on one run: same steps, same phase, and the
   *  only difference is whether the session is still in the turn. */
  it('withholds Retry from the same run while the session is still working', (t) => {
    const p = open(t);
    push(p, { ...stalled, status: 'busy' });
    assert.equal(
      p.window.document.querySelector('#wattach .wretry'),
      null,
      'a busy session is mid-step, not stalled'
    );

    push(p, stalled);
    assert.ok(
      p.window.document.querySelector('#wattach .wretry'),
      'the same record, once the turn is over, offers it'
    );
  });

  /** `waiting` is not `idle`: a session held at a permission prompt has not
   *  stopped, it is blocked on the reader — and offering to retry the step it
   *  is asking about would be the panel talking over its own dialog. */
  it('withholds Retry from a run whose session is waiting on the reader', (t) => {
    const p = open(t);
    push(p, { ...stalled, status: 'waiting' });
    assert.equal(p.window.document.querySelector('#wattach .wretry'), null);

    push(p, { ...failed, status: 'waiting' });
    assert.equal(
      p.window.document.querySelector('#wattach .wretry'),
      null,
      'a failed record does not lift the rule'
    );
  });

  /** Retry is the failed run's control alone: there is nothing to retry on a
   *  run that is working, and nothing left to fail on one that finished. */
  it('offers Retry on neither a working run nor a completed one', (t) => {
    const p = open(t);
    push(p, running);
    assert.equal(p.window.document.querySelector('#wattach .wretry'), null, 'not while working');

    push(p, done);
    assert.equal(p.window.document.querySelector('#wattach .wretry'), null, 'not once done');
  });

  /** Dismissing a failed run abandons the steps it has left, which is work —
   *  so unlike a completed one, it is asked about. */
  it('still asks before dismissing a failed run', (t) => {
    const p = open(t);
    push(p, failed);

    wcancel(p)?.click();
    assert.match(asking(p)?.textContent ?? '', /^Dismiss/);
    assert.equal(p.posted.at(-1)?.type !== 'cancelWorkflow', true, 'nothing posted on the press');
    answer(p, 'Dismiss');
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'cancelWorkflow', pid: 101 });
  });

  const done = threadView({
    pid: 101,
    status: 'idle',
    workflow: {
      label: 'plan→build→review',
      step: { label: 'Review', tone: 'done' },
      steps: [
        { id: 'plan', label: 'Plan', status: 'completed' },
        { id: 'build', label: 'Build', status: 'completed' },
        { id: 'review', label: 'Review', status: 'completed' }
      ]
    }
  });

  /**
   * Giving up the slot must not cost the chip its rail: a run that has stopped
   * is the one most worth walking step by step, and the drawer keys on the run
   * being on the wire rather than on it still working.
   */
  it('still opens the drawer from a finished chip', (t) => {
    const p = open(t);
    push(p, done);

    chip(p)?.click();
    const rail = p.window.document.querySelectorAll('#workflowoverviewdrawer .rdsteps .strow');
    assert.equal(rail.length, 3, 'the rail is drawn for a finished run');
  });

  /**
   * One chip, one job. A finished run holds the slot exactly as a working one
   * does: no Attach beside it, and a mention that reaches the map anyway is not
   * spent by the Enter that follows — there was no control to arm it with, and
   * two workflow pills in one composer say nothing about which the next message
   * carries.
   */
  it('holds the slot until the finished run is dismissed', (t) => {
    const p = open(t);
    push(p, done);

    assert.equal(
      p.window.document.querySelector('#wattach .fpill'),
      null,
      'no Attach beside a finished chip'
    );
    const chips = [...p.window.document.querySelectorAll<HTMLElement>('#wattach .wflow')];
    assert.equal(chips.length, 1);
    assert.ok(chips[0]?.classList.contains('live'));

    importComposer(p, 'still reading the last one');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'still reading the last one'
    });
  });

  /** And the × is the door to the next one: it frees the slot, Attach returns,
   *  and the workflow armed there is the one the send carries. */
  it('arms the next workflow once the finished one is dismissed', (t) => {
    const p = open(t);
    push(p, done);
    wcancel(p)?.click();

    // The host answers the dismiss by taking the run off the wire.
    push(p, threadView({ pid: 101, status: 'idle' }));
    assert.ok(p.window.document.querySelector('#wattach .fpill'), 'Attach is back');

    attach(p, 'spike→report');
    assert.ok(chip(p)?.classList.contains('armed'));
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: '',
      workflowId: 'spike'
    });
  });

  /**
   * A run that stops between two pushes takes its question with it. Left
   * standing, the confirm would be answered against whatever reached the slot
   * next — which is a press the reader aimed at something else.
   */
  it('drops the question when the run leaves under it', (t) => {
    const p = open(t);
    push(p, running);
    wcancel(p)?.click();
    assert.ok(asking(p));

    push(p, threadView({ pid: 101, status: 'idle' }));
    assert.equal(asking(p), null);
    assert.ok(p.window.document.querySelector('#wattach .fpill'));
  });

  it('selects, starts, progresses, completes, then starts another workflow', (t) => {
    const p = open(t);

    // --- empty shelf: Attach is the door, not a live Following chip ------------
    assert.ok(
      p.window.document.querySelector('#wattach .fpill'),
      'fresh session offers Attach before any run'
    );
    assert.equal(chip(p), null, 'no Following on open without provenance');

    // --- pick among more than one authored workflow ----------------------------
    p.window.document.querySelector<HTMLElement>('#wattach .fpill')?.click();
    const labels = attachRows(p);
    assert.ok(
      labels.some((l) => l.includes('plan→build→review')),
      `the menu is missing plan→build→review: ${labels.join(' | ')}`
    );
    assert.ok(
      labels.some((l) => l.includes('spike→report')),
      `the menu is missing spike→report: ${labels.join(' | ')}`
    );
    assert.ok(labels.length >= 2, `need ≥2 workflows to pick among; got ${labels.length}`);

    // The pill is a toggle, so this read has to put the menu back: `attach`
    // presses it again, and on a menu already up that press is the close.
    p.window.document.querySelector<HTMLElement>('#wattach .fpill')?.click();
    attach(p, 'plan→build→review');

    // Armed mention — named artifact, exclusive (no Attach sibling).
    assert.ok(chip(p)?.classList.contains('armed'));
    assert.match(chip(p)?.textContent ?? '', /plan→build→review/);
    assert.match(chip(p)?.textContent ?? '', /3 steps/);
    assert.equal(p.window.document.querySelector('#wattach .fpill'), null);

    // Peek the process before spending it (A6).
    p.window.document.querySelector<HTMLElement>('#wattach .peek')?.click();
    assert.deepEqual(
      [...p.window.document.querySelectorAll('#wattach .wstep')].map((s) => s.textContent),
      ['Plan', 'Build', 'Review']
    );

    // --- start: Enter spends the mention ---------------------------------------
    importComposer(p, 'ship this');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'ship this',
      workflowId: 'ship'
    });
    // Q12 one-shot: mention is spent before the host paints live provenance.
    assert.equal(chip(p), null);

    // --- live observe: Following + step progress (host → thread.workflow) ------
    push(
      p,
      threadView({
        pid: 101,
        status: 'busy',
        workflow: { label: 'plan→build→review', step: { label: 'Plan', tone: 'working' } },
        exchanges: [
          {
            role: 'user',
            text: 'ship this',
            blocks: [{ prose: 'ship this' }]
          }
        ]
      })
    );
    assert.ok(chip(p)?.classList.contains('running'));
    assert.equal(verb(p), 'Following');
    assert.equal(name(p), 'plan→build→review');
    assert.equal(step(p), 'Plan');
    assert.ok(chip(p)?.querySelector('.sname')?.classList.contains('working'));
    assert.equal(p.window.document.querySelector('#wattach .fpill'), null, 'no Attach while live');

    // Mid-pipeline: next step owns the lean marker.
    push(
      p,
      threadView({
        pid: 101,
        status: 'busy',
        workflow: { label: 'plan→build→review', step: { label: 'Build', tone: 'working' } }
      })
    );
    assert.equal(verb(p), 'Following');
    assert.equal(step(p), 'Build');

    // Waiting outranks busy on the same seat.
    push(
      p,
      threadView({
        pid: 101,
        status: 'waiting',
        waitingFor: 'permission',
        workflow: { label: 'plan→build→review', step: { label: 'Build', tone: 'working' } }
      })
    );
    assert.ok(chip(p)?.classList.contains('waiting'));
    assert.equal(verb(p), 'Waiting');

    // Back to work, then terminal step.
    push(
      p,
      threadView({
        pid: 101,
        status: 'busy',
        workflow: { label: 'plan→build→review', step: { label: 'Review', tone: 'working' } }
      })
    );
    assert.equal(verb(p), 'Following');
    assert.equal(step(p), 'Review');

    push(
      p,
      threadView({
        pid: 101,
        status: 'idle',
        workflow: { label: 'plan→build→review', step: { label: 'Review', tone: 'done' } }
      })
    );
    assert.ok(chip(p)?.classList.contains('done'));
    assert.equal(verb(p), 'Done');
    assert.equal(step(p), 'Review');
    // A finished run keeps its chip and keeps the lock with it: what it reached
    // is still worth reading, and the next workflow is armed in the space its ×
    // leaves rather than beside it.
    assert.equal(
      p.window.document.querySelector('#wattach .fpill'),
      null,
      'no Attach until the finished chip is dismissed'
    );

    // Free-text while following must not re-arm a second workflowId.
    importComposer(p, 'still on the first');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'still on the first'
    });

    // --- provenance ends: the chip goes too ------------------------------------
    push(p, threadView({ pid: 101, status: 'idle' }));
    assert.equal(chip(p), null);
    assert.ok(
      p.window.document.querySelector('#wattach .fpill'),
      'Attach stands alone once the run is off the wire'
    );

    // --- start a different workflow on the same session ------------------------
    attach(p, 'spike→report');
    assert.ok(chip(p)?.classList.contains('armed'));
    assert.match(chip(p)?.textContent ?? '', /spike→report/);
    assert.match(chip(p)?.textContent ?? '', /2 steps/);

    enter(p); // empty box: a workflow alone is a legal send
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: '',
      workflowId: 'spike'
    });

    push(
      p,
      threadView({
        pid: 101,
        status: 'busy',
        workflow: { label: 'spike→report', step: { label: 'Spike', tone: 'working' } }
      })
    );
    assert.equal(verb(p), 'Following');
    assert.equal(name(p), 'spike→report');
    assert.equal(step(p), 'Spike');
    assert.equal(
      p.window.document.querySelector('#wattach .fpill'),
      null,
      'second live run also hides Attach'
    );

    push(
      p,
      threadView({
        pid: 101,
        status: 'idle',
        workflow: { label: 'spike→report', step: { label: 'Report', tone: 'done' } }
      })
    );
    assert.equal(verb(p), 'Done');
    assert.equal(name(p), 'spike→report');
    assert.equal(step(p), 'Report');

    // Still held, as the first run's chip was: a finished run gives up the slot
    // on its ×, and the host answers that press by taking it off the wire.
    assert.equal(p.window.document.querySelector('#wattach .fpill'), null);
    wcancel(p)?.click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'cancelWorkflow', pid: 101 });
    push(p, threadView({ pid: 101, status: 'idle' }));
    assert.ok(p.window.document.querySelector('#wattach .fpill'));
    assert.equal(chip(p), null);
  });

  /**
   * A press is a mousedown and a mouseup with up to a poll's worth of time
   * between them. Rebuild the control in that gap and the click is never
   * dispatched — the node the press landed on has been detached, and the
   * browser has nothing to fire at. The slot rebuilt itself on every push, so
   * Attach, the chip's three and the live chip all dropped presses; measured in
   * a real browser before this was written.
   *
   * Node identity is the assertion jsdom can carry, and it is the same fact: a
   * slot that rebuilds is a slot that loses presses.
   */
  it('keeps the slot’s controls across a poll, in each of its three modes', (t) => {
    const p = open(t);
    const $one = (sel: string): HTMLElement | null =>
      p.window.document.querySelector<HTMLElement>(sel);

    // --- empty: the Attach pill -----------------------------------------------
    const pill = $one('#wattach .fpill');
    assert.ok(pill);
    push(p, threadView({ pid: 101, status: 'idle' }));
    assert.equal($one('#wattach .fpill'), pill, 'Attach was rebuilt under the pointer');

    // --- armed: peek, Edit and × ----------------------------------------------
    attach(p, 'plan→build→review');
    const armed = chip(p);
    const peek = $one('#wattach .peek');
    const edit = $one('#wattach .wedit');
    const drop = $one('#wattach .drop');
    assert.ok(armed && peek && edit && drop);

    push(p, threadView({ pid: 101, status: 'idle' }));
    assert.equal(chip(p), armed, 'the armed chip was rebuilt under the pointer');
    assert.equal($one('#wattach .peek'), peek, 'peek was rebuilt under the pointer');
    assert.equal($one('#wattach .wedit'), edit, 'Edit was rebuilt under the pointer');
    assert.equal($one('#wattach .drop'), drop, '× was rebuilt under the pointer');

    // --- live: the chip is the drawer's toggle --------------------------------
    const live = threadView({
      pid: 101,
      status: 'busy',
      workflow: { label: 'plan→build→review', step: { label: 'Plan', tone: 'working' } }
    });
    push(p, live);
    const following = chip(p);
    assert.ok(following?.classList.contains('live'));

    push(p, live);
    assert.equal(chip(p), following, 'the live chip was rebuilt under the pointer');
  });

  // The other half: a slot that never repaints would be worse than one that
  // repaints too much, so each of the facts it draws has to still move it.
  it('still repaints the slot when what it draws changes', (t) => {
    const p = open(t);
    attach(p, 'plan→build→review');
    assert.match(chip(p)?.textContent ?? '', /plan→build→review/);

    // The step moves under a live run.
    push(
      p,
      threadView({
        pid: 101,
        status: 'busy',
        workflow: { label: 'plan→build→review', step: { label: 'Plan', tone: 'working' } }
      })
    );
    assert.equal(step(p), 'Plan');
    push(
      p,
      threadView({
        pid: 101,
        status: 'busy',
        workflow: { label: 'plan→build→review', step: { label: 'Build', tone: 'working' } }
      })
    );
    assert.equal(step(p), 'Build', 'a step that moved must repaint the chip');

    // And the run ending gives the slot back to Attach.
    push(p, threadView({ pid: 101, status: 'idle' }));
    assert.equal(chip(p), null);
    assert.ok(p.window.document.querySelector('#wattach .fpill'));
  });

  /**
   * The trap a signature sets, and the reason every other repaint rule here is
   * about *what is drawn*: a handler on a node the paint kept still holds the
   * view it was built with. Edit the prompts of a workflow without touching its
   * name or its step count and nothing a signature can see has moved — so the
   * chip stands, its Edit closure holds the workflow as it was, and pressing it
   * opens the old prompts. Saving from there writes them back over the edit.
   *
   * The rule this states: **a surviving node's handler reads live state, never a
   * captured view.** The step labels are the other half — those *are* drawn, so
   * they belong in the signature rather than in the closure.
   */
  it('opens Edit on the workflow as it is now, not as it was when the chip was drawn', (t) => {
    const p = open(t);
    attach(p, 'plan→build→review');
    // The fold is opened *first*, and that matters: opening it is itself a
    // repaint, so a scenario that clicked peek after the push would rebuild the
    // chip on the way in and read fresh names off a bug that is still there.
    p.window.document.querySelector<HTMLElement>('#wattach .peek')?.click();

    // Same id, same label, same step count — a prompt rewritten and a step
    // renamed. Nothing here changes what the chip itself says.
    const edited = [
      workflowView({
        id: 'ship',
        label: 'plan→build→review',
        steps: [
          { id: 'plan', label: 'Plan', prompt: 'plan it *properly*' },
          { id: 'build', label: 'Assemble', prompt: 'build it' },
          { id: 'review', label: 'Review', prompt: 'review it' }
        ]
      }),
      ...WORKFLOWS.slice(1)
    ];
    push(p, threadView({ pid: 101, status: 'idle' }), { workflows: edited });

    // The fold draws step names, so a renamed step has to reach it.
    assert.deepEqual(
      [...p.window.document.querySelectorAll('#wattach .wstep')].map((s) => s.textContent),
      ['Plan', 'Assemble', 'Review'],
      'a renamed step must reach the fold'
    );

    p.window.document.querySelector<HTMLElement>('#wattach .wedit')?.click();
    // Edit opens closed. The prompt is the closed face's description; a field
    // exists only after the node is opened.
    assert.equal(
      p.window.document.querySelector('#wfeditor .wcnode .wcdesc')?.textContent,
      'plan it *properly*',
      'Edit opened the workflow as it was, not as it is'
    );
  });

  // M-1: `status` is the most volatile field a thread carries, and the live chip
  // is drawn from what it *means* rather than from the word itself. Fingerprinting
  // the raw word rebuilds an identical chip on every flip, which is the bug this
  // whole change is about, reintroduced one layer down. The chip is the drawer's
  // toggle, so it is a control, not a readout.
  //
  // **The flip this uses moved once.** It was busy↔idle, which is no longer a
  // pair that draws the same slot: an idle session with steps left is a stopped
  // run, and a stopped run gains Retry. So the pair here is two words that still
  // mean the same thing to this slot, and the case below states the other half
  // — that crossing into idle redraws, and why that is a control appearing
  // rather than an identical chip rebuilt.
  const following = (status: SessionStatusView) =>
    threadView({
      pid: 101,
      status,
      workflow: { label: 'plan→build→review', step: { label: 'Build', tone: 'working' } }
    });

  it('keeps the live chip across a status flip that draws the same chip', (t) => {
    const p = open(t);
    push(p, following('busy'));
    const chipNode = chip(p);
    assert.equal(verb(p), 'Following');

    push(p, following('unknown'));

    assert.equal(verb(p), 'Following', 'the chip says the same thing either way');
    assert.equal(chip(p), chipNode, 'an identical chip was rebuilt under the pointer');
  });

  /**
   * The cost of drawing Retry off the session's status, stated rather than
   * discovered: the busy→idle edge now changes what the slot holds, so the node
   * cannot survive it.
   *
   * That is not M-1 coming back. M-1 was an identical chip rebuilt on **every**
   * push, because the raw status word flips constantly; this is one rebuild at a
   * turn boundary, and it happens because a control the reader did not have a
   * moment ago is now there. A signature that skipped it would draw the run as
   * stopped without ever drawing the button.
   */
  it('redraws the slot when a run stops, because it gains a control', (t) => {
    const p = open(t);
    push(p, following('busy'));
    const chipNode = chip(p);
    assert.equal(p.window.document.querySelector('#wattach .wretry'), null);

    push(p, following('idle'));

    assert.notEqual(chip(p), chipNode, 'the slot kept a signature it should have changed');
    assert.ok(p.window.document.querySelector('#wattach .wretry'), 'and Retry is what it gained');
  });

  // The peek fold is webview-local: nothing on the state says it is open, so a
  // signature that only watched the state would freeze the caret shut.
  it('opens the peek fold on the click, not on the next push', (t) => {
    const p = open(t);
    attach(p, 'plan→build→review');
    p.window.document.querySelector<HTMLElement>('#wattach .peek')?.click();

    assert.deepEqual(
      [...p.window.document.querySelectorAll('#wattach .wstep')].map((s) => s.textContent),
      ['Plan', 'Build', 'Review']
    );
    push(p, threadView({ pid: 101, status: 'idle' }));
    assert.equal(
      p.window.document.querySelectorAll('#wattach .wstep').length,
      3,
      'the poll must not shut a fold the reader opened'
    );
  });

  it('does not carry an armed fold to another chat using the same workflow', (t) => {
    const groups = [
      groupView({
        sessions: [
          cardView({ pid: 101, startedAt: 5_000 }),
          cardView({ pid: 202, startedAt: 6_000 })
        ]
      })
    ];
    const p = openPanel(t);
    p.push(stateMessage(groups, { workflows: WORKFLOWS }));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    p.push(
      stateMessage(groups, {
        workflows: WORKFLOWS,
        thread: threadView({ pid: 101, startedAt: 5_000, status: 'idle' })
      })
    );
    attach(p, 'plan→build→review');
    p.window.document.querySelector<HTMLElement>('#wattach .peek')?.click();
    assert.equal(p.window.document.querySelectorAll('#wattach .wstep').length, 3);

    p.window.document.querySelector<HTMLElement>('.card[data-pid="202"]')?.click();
    p.push(
      stateMessage(groups, {
        workflows: WORKFLOWS,
        thread: threadView({ pid: 202, startedAt: 6_000, status: 'idle' })
      })
    );
    attach(p, 'plan→build→review');
    assert.equal(p.window.document.querySelectorAll('#wattach .wstep').length, 0);
  });
});
