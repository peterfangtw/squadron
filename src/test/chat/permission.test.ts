import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  answerRespond,
  assertedMessageBody,
  askRequest,
  cardView,
  groupView,
  openThread,
  permissionRequest,
  questionView,
  stateMessage,
  threadView,
  typeProse,
  Panel
} from '../harness';

/**
 * The dock answering a request of a session the panel drives itself.
 *
 * These are the requests that used to be unanswerable: an owned session's ask
 * and its permission prompts arrive on its pipe, and until this surface existed
 * a session blocked on either sat there with nothing on screen able to unblock
 * it. Both arrive as one `can_use_tool`, so both are rendered by one list here.
 */
describe('the requests an owned session is blocked on', () => {
  const dialogs = (p: Panel): HTMLElement[] => [
    ...p.window.document.querySelectorAll<HTMLElement>('#question .pdlg')
  ];
  const responses = (p: Panel): unknown[] =>
    p.posted.filter((m) => m.type === 'respond').map(assertedMessageBody);
  const button = (dlg: HTMLElement, cls: string): HTMLButtonElement | null =>
    dlg.querySelector<HTMLButtonElement>(cls);

  it('names the tool, what it wants, and shows its input as text', (t) => {
    // The input is a model's own output on its way to a person, so it is shown
    // as characters and never as markup — the same rule the thread's turns get,
    // for a string with a lot less between it and the reader.
    const p = openThread(
      t,
      threadView({
        pending: [
          permissionRequest({
            toolName: 'Bash',
            label: 'Write hi to probe-out.txt',
            input: '{\n  "command": "echo <img src=x onerror=alert(1)> > out.txt"\n}'
          })
        ]
      })
    );
    assert.equal(dialogs(p).length, 1);
    const dlg = dialogs(p)[0] as HTMLElement;
    assert.equal(dlg.querySelector('.ptool')?.textContent, 'Bash');
    assert.equal(dlg.querySelector('.plabel')?.textContent, 'Write hi to probe-out.txt');
    assert.match(dlg.querySelector('pre.pin')?.textContent ?? '', /echo <img src=x/);
    assert.equal(dlg.querySelector('img'), null, 'the input is text, not markup');
  });

  it('allows once, persisting nothing', (t) => {
    const p = openThread(t, threadView({ pending: [permissionRequest()] }));
    button(dialogs(p)[0] as HTMLElement, '.pallow')?.click();
    assert.deepEqual(responses(p), [
      { type: 'respond', pid: 101, requestId: 'req-1', decision: { allow: true } }
    ]);
  });

  it('denies, and lets the session carry on', (t) => {
    // A denial is not an error and needs no words from here: the CLI tells the
    // model the tool was refused, the turn still ends `success`, and the reason
    // the panel would invent would be a reason nobody gave. So the reason box
    // is disclosed, and the button inside it still decides with nothing in it.
    const p = openThread(t, threadView({ pending: [permissionRequest()] }));
    const dlg = dialogs(p)[0] as HTMLElement;
    assert.equal(dlg.querySelector('.say-in'), null, 'no box before anyone means to refuse');
    button(dlg, '.pdeny')?.click();
    assert.deepEqual(responses(p), [], 'the row’s button opens the reason, it does not decide');
    button(dialogs(p)[0] as HTMLElement, '.pdeny-go')?.click();
    assert.deepEqual(responses(p), [
      { type: 'respond', pid: 101, requestId: 'req-1', decision: { allow: false } }
    ]);
  });

  it('denies directly when this session cannot carry a reason', (t) => {
    const p = openThread(t, threadView({ pending: [permissionRequest({ canDenyReason: false })] }));
    const dlg = dialogs(p)[0] as HTMLElement;
    assert.equal(dlg.querySelector('.say-in'), null);
    assert.equal(button(dlg, '.pdeny-go'), null);
    button(dlg, '.pdeny')?.click();
    assert.deepEqual(responses(p), [
      { type: 'respond', pid: 101, requestId: 'req-1', decision: { allow: false } }
    ]);
  });

  it('denies with a reason, and sends it verbatim', (t) => {
    // `RequestDecision`'s deny arm has always carried `message?`, and until now
    // nothing set it: every denial the panel sent read `Denied from AgentsView.`
    // to the model. The box is on deny alone — an allow needs no words, and a
    // box under one would invite instructions that are sent nowhere.
    const p = openThread(t, threadView({ pending: [permissionRequest()] }));
    button(dialogs(p)[0] as HTMLElement, '.pdeny')?.click();
    const dlg = dialogs(p)[0] as HTMLElement;
    const say = dlg.querySelector<HTMLElement>('.say-in');
    assert.ok(say, 'no reason box on the deny');
    assert.match(
      dlg.querySelector('.qbail-why')?.textContent ?? '',
      /Left empty/,
      'what an empty box means, said where it can be read'
    );
    assert.equal(dlg.querySelector('.pallow')?.parentElement?.querySelector('.say-in'), null);
    typeProse(p, say, 'That file is generated — edit the template instead.');
    button(dialogs(p)[0] as HTMLElement, '.pdeny-go')?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'req-1',
      decision: { allow: false, message: 'That file is generated — edit the template instead.' }
    });
  });

  it('still denies with an empty box, saying nothing of its own', (t) => {
    // A denial is not an error: with no words typed the CLI tells the model its
    // tool was refused, and a reason invented here is a reason nobody gave.
    const p = openThread(t, threadView({ pending: [permissionRequest()] }));
    button(dialogs(p)[0] as HTMLElement, '.pdeny')?.click();
    typeProse(p, (dialogs(p)[0] as HTMLElement).querySelector('.say-in'), '   ');
    button(dialogs(p)[0] as HTMLElement, '.pdeny-go')?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'req-1',
      decision: { allow: false }
    });
  });

  it('holds the whole dialog until a push speaks for the decision', (t) => {
    // Nothing here stages — the button pressed is the decision — but the push
    // that takes the dialog away is a refresh behind a pipe write, and for that
    // second the dialog is still on screen. Live, it reads as three buttons
    // that did nothing, and a second press posts a second response against a
    // request that is already answered.
    const thread = threadView({ pending: [permissionRequest({ always: 'Bash(echo:*)' })] });
    const p = openThread(t, thread);
    button(dialogs(p)[0] as HTMLElement, '.pallow')?.click();
    assert.equal(responses(p).length, 1);

    const dlg = dialogs(p)[0] as HTMLElement;
    assert.equal(button(dlg, '.pallow')?.textContent, 'Sending…', 'the one that was pressed');
    assert.equal(button(dlg, '.pallow')?.disabled, true);
    // Its peers go dead without claiming it: an `Always allow` reading
    // "Sending…" because Allow once was pressed would name the wrong answer.
    assert.equal(button(dlg, '.palways')?.disabled, true);
    assert.match(button(dlg, '.palways')?.textContent ?? '', /^Always allow/);
    assert.equal(button(dlg, '.pdeny')?.disabled, true);
    assert.equal(button(dlg, '.pdeny')?.textContent, 'Deny…');

    button(dialogs(p)[0] as HTMLElement, '.palways')?.click();
    button(dialogs(p)[0] as HTMLElement, '.pdeny')?.click();
    assert.equal(responses(p).length, 1, 'one decision, one response');

    // A push still carrying the request is not the host speaking for it: the
    // window driving a session republishes on a debounce, so this one can be
    // older than the answer it appears to contradict.
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: thread.pid })] })], { thread }));
    assert.equal(button(dialogs(p)[0] as HTMLElement, '.pallow')?.disabled, true);

    // The report is, and a refusal hands all three back with its reason on the
    // dialog — where the decision was made, and not in a host notification.
    answerRespond(p, {
      ok: false,
      reason: 'That request was withdrawn before you answered it.'
    });
    const back = dialogs(p)[0] as HTMLElement;
    assert.match(back.querySelector('.qfail')?.textContent ?? '', /withdrawn/);
    assert.equal(button(back, '.pallow')?.textContent, 'Allow once');
    assert.equal(button(back, '.pallow')?.disabled, false);
    assert.equal(button(back, '.palways')?.textContent, 'Always allow · Bash(echo:*)');
    assert.equal(button(back, '.palways')?.disabled, false);
    assert.equal(button(back, '.pdeny')?.disabled, false);
  });

  it('holds the deny button inside the reason drawer, not the row’s own', (t) => {
    // The denial is sent from inside the drawer, so that is the button that
    // says it is sending; the row's `Deny…` only opened it and is a peer.
    const p = openThread(t, threadView({ pending: [permissionRequest()] }));
    button(dialogs(p)[0] as HTMLElement, '.pdeny')?.click();
    button(dialogs(p)[0] as HTMLElement, '.pdeny-go')?.click();
    assert.equal(responses(p).length, 1);

    const dlg = dialogs(p)[0] as HTMLElement;
    assert.equal(button(dlg, '.pdeny-go')?.textContent, 'Sending…');
    assert.equal(button(dlg, '.pdeny-go')?.disabled, true);
    assert.equal(button(dlg, '.pdeny')?.textContent, 'Deny…');
    assert.equal(button(dlg, '.pdeny')?.disabled, true);
    assert.equal(button(dlg, '.pallow')?.disabled, true);

    button(dialogs(p)[0] as HTMLElement, '.pdeny-go')?.click();
    assert.equal(responses(p).length, 1, 'one decision, one response');
  });

  it('offers no always-allow when the request suggested no rule', (t) => {
    // There is no standalone permissions control request: a rule can only ride
    // on an allow, and the rule's syntax is the CLI's. With no suggestion there
    // is nothing correct to send, so nothing is offered.
    const p = openThread(t, threadView({ pending: [permissionRequest()] }));
    assert.equal(button(dialogs(p)[0] as HTMLElement, '.palways'), null);
    assert.ok(button(dialogs(p)[0] as HTMLElement, '.pallow'), 'allow-once is always there');
  });

  it('names where an always-allow writes, and says so on the button', (t) => {
    const p = openThread(
      t,
      threadView({
        pending: [permissionRequest({ always: '.claude/settings.local.json, in this project' })]
      })
    );
    const always = button(dialogs(p)[0] as HTMLElement, '.palways');
    assert.ok(always);
    assert.match(always.textContent ?? '', /\.claude\/settings\.local\.json, in this project/);
    always.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'req-1',
      decision: { allow: true, always: true }
    });
  });

  it('renders two open requests as two dialogs, and answering one leaves the other', (t) => {
    // `pending_permission_requests` is plural on the wire. A dock that rendered
    // only the first would leave the session blocked on one nobody can see.
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openThread(
      t,
      threadView({
        pending: [
          permissionRequest({ requestId: 'req-1', label: 'notes.txt' }),
          permissionRequest({ requestId: 'req-2', label: 'other.txt' })
        ]
      })
    );
    assert.equal(dialogs(p).length, 2);
    assert.equal(dialogs(p)[0]?.querySelector('.plabel')?.textContent, 'notes.txt');
    assert.equal(dialogs(p)[1]?.querySelector('.plabel')?.textContent, 'other.txt');

    button(dialogs(p)[0] as HTMLElement, '.pallow')?.click();
    assert.deepEqual(responses(p).at(-1), {
      type: 'respond',
      pid: 101,
      requestId: 'req-1',
      decision: { allow: true }
    });

    // The host answers the one it was told about; the other is still open.
    p.push(
      stateMessage(groups, {
        thread: threadView({
          pending: [permissionRequest({ requestId: 'req-2', label: 'other.txt' })]
        })
      })
    );
    assert.equal(dialogs(p).length, 1);
    assert.equal(dialogs(p)[0]?.querySelector('.plabel')?.textContent, 'other.txt');
  });

  it('clears a dialog the CLI retracted under the reader', (t) => {
    // Reachable, and the trigger is an interrupt: `control_cancel_request`
    // arrives about a millisecond after one, and before the interrupt's own
    // response. A dialog left standing would offer to allow something nothing is
    // waiting for.
    const groups = [groupView({ sessions: [cardView({ pid: 101 })] })];
    const p = openThread(t, threadView({ pending: [permissionRequest()] }));
    assert.equal(dialogs(p).length, 1);
    p.push(stateMessage(groups, { thread: threadView({ pending: [] }) }));
    assert.equal(dialogs(p).length, 0);
    assert.equal(
      (p.window.document.getElementById('qlaunch') as HTMLElement).hidden,
      true,
      'and the launcher goes with it'
    );
  });

  it('announces what is waiting, and how many', (t) => {
    const p = openThread(
      t,
      threadView({
        pending: [
          permissionRequest({ requestId: 'req-1' }),
          askRequest({ requestId: 'req-2', questions: [questionView({ header: 'Route' })] })
        ]
      })
    );
    const launcher = p.window.document.getElementById('qlaunch') as HTMLElement;
    assert.equal(launcher.hidden, false);
    assert.match(launcher.textContent ?? '', /notes\.txt/, 'the oldest request is named');
    assert.match(launcher.textContent ?? '', /2/, 'and the reader is told there are two');
  });

  it('renders an ask and a permission side by side, each with its own controls', (t) => {
    const p = openThread(
      t,
      threadView({
        pending: [
          askRequest({ requestId: 'req-1' }),
          permissionRequest({ requestId: 'req-2', toolName: 'Write' })
        ]
      })
    );
    assert.equal(dialogs(p).length, 2);
    assert.ok(dialogs(p)[0]?.querySelector('.qopt'), 'the ask keeps its options');
    assert.equal(dialogs(p)[0]?.querySelector('.pallow'), null);
    assert.ok(dialogs(p)[1]?.querySelector('.pallow'), 'the permission keeps its buttons');
    assert.equal(dialogs(p)[1]?.querySelector('.qopt'), null);
  });
});
