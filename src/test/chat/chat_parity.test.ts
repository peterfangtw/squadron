/**
 * Composer behavior shared by a New chat and an existing idle owned chat.
 *
 * One fixture set, two owners. Delivered `send` bodies are compared after
 * answering New's `open`/`reveal`; that startup exchange is the only
 * allowed difference. Startup-only sequences live in the second describe.
 */
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import {
  answerFilePick,
  answerOpen,
  answerSend,
  assertedMessageBody,
  attachWorkflow,
  cardView,
  composerKey,
  composerValue,
  enter,
  groupView,
  lastOpen,
  newDraft,
  openPanel,
  pasteComposer,
  selectComposer,
  stateMessage,
  threadView,
  typeIn,
  typeMention,
  workflowView,
  type Panel
} from '../harness';

const CWD = '/Users/someone/proj';
const SKILLS = ['dataviz', 'ponytail'];
const WORKFLOWS = [workflowView({ id: 'ship', label: 'plan→build→review' })];
const CARD = cardView({ pid: 101, startedAt: 5_000, owned: true, fullCwd: CWD });
const THREAD = threadView({
  pid: 101,
  startedAt: 5_000,
  skills: SKILLS,
  canSend: true,
  canAttach: true,
  owned: true,
  fullCwd: CWD
});

type Kind = 'new' | 'existing';

const groups = (sessions: CardView[] = []) => [
  groupView({ cwd: CWD, sessions, skillsByBrand: { claude: SKILLS } })
];

const extra = { workflows: WORKFLOWS };

function open(t: TestContext, kind: Kind): Panel {
  const p = openPanel(t);
  if (kind === 'existing') {
    p.push(stateMessage(groups([CARD]), extra));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(groups([CARD]), { ...extra, thread: THREAD }));
    return p;
  }
  p.push(stateMessage(groups(), extra));
  newDraft(p, CWD);
  return p;
}

const sendBtn = (p: Panel): HTMLButtonElement =>
  p.window.document.getElementById('send') as HTMLButtonElement;

const clip = (p: Panel): HTMLButtonElement =>
  p.window.document.getElementById('fattach') as HTMLButtonElement;

const lastSend = (p: Panel): Extract<WebviewMessage, { type: 'send' }> => {
  const sent = [...p.posted].reverse().find((m) => m.type === 'send');
  assert.ok(sent && sent.type === 'send', 'nothing posted a send');
  return sent;
};

const retryHeld = (p: Panel): void => {
  const btn = p.window.document.querySelector<HTMLElement>('[data-act="retry-held"]');
  assert.ok(btn, 'held retry was not shown');
  btn.click();
};

/** Enter, and for New answer the start so the ordinary send can land. */
function deliver(p: Panel, kind: Kind, pid = 8): Extract<WebviewMessage, { type: 'send' }> {
  enter(p);
  if (kind === 'new') {
    assert.ok(
      p.posted.some((m) => m.type === 'open'),
      'New did not start before the shared send'
    );
    answerOpen(p, pid, 8_000);
  }
  return lastSend(p);
}

function at(p: Panel): void {
  typeMention(p, '');
}

const skillRows = (p: Panel): string[] =>
  [...p.window.document.querySelectorAll('#mentionmenu:not([hidden]) .mnrow')].map(
    (r) => r.textContent?.trim() ?? ''
  );

async function pastePng(p: Panel): Promise<void> {
  pasteComposer(p, { files: [{ name: 'shot.png', type: 'image/png' }] });
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

describe('composer parity, New vs existing', () => {
  for (const kind of ['new', 'existing'] as const) {
    it(`sends a workflow alone (${kind})`, (t) => {
      const p = open(t, kind);
      assert.equal(sendBtn(p).disabled, true);
      attachWorkflow(p, 'plan→build→review');
      assert.equal(sendBtn(p).disabled, false, 'an armed workflow was not something to send');
      const sent = deliver(p, kind);
      assert.equal((assertedMessageBody(sent) as { workflowId?: string }).workflowId, 'ship');
    });

    it(`expands a directory skill on send (${kind})`, (t) => {
      const p = open(t, kind);
      at(p);
      assert.deepEqual(skillRows(p), SKILLS);
      p.window.document.querySelector<HTMLElement>('#mentionmenu .mnrow')?.click();
      assert.equal(composerValue(p), 'the dataviz skill ');
      const sent = deliver(p, kind);
      assert.equal((assertedMessageBody(sent) as { text: string }).text, 'the dataviz skill');
    });

    it(`sends a picked file (${kind})`, (t) => {
      const p = open(t, kind);
      typeIn(p, 'read this ', 'read this '.length);
      clip(p).click();
      answerFilePick(p, ['/tmp/a.ts']);
      assert.equal(composerValue(p), 'read this /tmp/a.ts ');
      const sent = deliver(p, kind);
      assert.equal((assertedMessageBody(sent) as { text: string }).text, 'read this /tmp/a.ts');
    });

    it(`sends a pasted image (${kind})`, async (t) => {
      const p = open(t, kind);
      await pastePng(p);
      assert.match(composerValue(p), /\[Image #1\]/);
      const sent = deliver(p, kind);
      const body = assertedMessageBody(sent) as { text: string; images?: { name: string }[] };
      assert.match(body.text, /\[Image #1\]/);
      assert.equal(body.images?.length, 1);
      assert.equal(body.images?.[0]?.name, 'shot.png');
    });

    it(`deletes a file token as one unit (${kind})`, (t) => {
      const p = open(t, kind);
      clip(p).click();
      answerFilePick(p, ['/tmp/a.ts']);
      assert.equal(composerValue(p), '/tmp/a.ts ');
      // Just after the chip, before the space set after it.
      selectComposer(p, composerValue(p).trimEnd().length);
      composerKey(p, 'Backspace', { cancelable: false });
      assert.equal(composerValue(p).trim(), '');
      assert.equal(sendBtn(p).disabled, true);
    });

    it(`keeps compose across a switch away and back (${kind})`, (t) => {
      const other = cardView({ pid: 3, startedAt: 3_000, owned: true });
      const p = openPanel(t);
      if (kind === 'existing') {
        p.push(stateMessage(groups([CARD, other]), extra));
        p.window.document.querySelector<HTMLElement>(`.card[data-pid="${CARD.pid}"]`)?.click();
        p.push(stateMessage(groups([CARD, other]), { ...extra, thread: THREAD }));
      } else {
        p.push(stateMessage(groups([other]), extra));
        newDraft(p, CWD);
      }
      typeIn(p, 'still here');
      p.window.document.querySelector<HTMLElement>('.card[data-pid="3"]')?.click();
      p.push(
        stateMessage(groups(kind === 'existing' ? [CARD, other] : [other]), {
          ...extra,
          thread: threadView({ pid: 3, startedAt: 3_000, owned: true })
        })
      );
      if (kind === 'existing') {
        p.window.document.querySelector<HTMLElement>(`.card[data-pid="${CARD.pid}"]`)?.click();
        p.push(stateMessage(groups([CARD, other]), { ...extra, thread: THREAD }));
      } else {
        newDraft(p, CWD);
      }
      assert.equal(composerValue(p), 'still here');
    });

    it(`restores a refused send without clobbering newer input (${kind})`, (t) => {
      const p = open(t, kind);
      typeIn(p, 'first');
      const sent = deliver(p, kind, kind === 'new' ? 8 : CARD.pid);
      const pid = sent.pid;
      const startedAt = sent.startedAt;
      typeIn(p, 'newer');
      p.push({
        type: 'sendResult',
        pid,
        startedAt,
        operationId: sent.operationId,
        ok: false,
        reason: 'session is gone'
      });
      assert.equal(composerValue(p), 'newer', 'the refusal overwrote later typing');
    });
  }

  it('keeps model changes off a bound session that forbids them, and on New', (t) => {
    const p = open(t, 'existing');
    p.push(
      stateMessage(groups([CARD]), {
        ...extra,
        thread: { ...THREAD, canModel: false }
      })
    );
    const bound = p.window.document.querySelector<HTMLButtonElement>('.fpill.model');
    assert.ok(bound);
    assert.equal(bound.disabled, true);

    const q = open(t, 'new');
    const unbound = q.window.document.querySelector<HTMLButtonElement>('.fpill.model');
    assert.ok(unbound);
    assert.equal(unbound.disabled, false);
  });
});

describe('New startup is the only extra delivery step', () => {
  const board = (sessions: CardView[] = []) => groups(sessions);

  it('reconciles a state push that names the pid before reveal', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'hello');
    enter(p);
    const started = cardView({ pid: 8, startedAt: 8_000, owned: true });
    p.push(stateMessage(board([started]), extra));
    answerOpen(p, 8, 8_000);
    assert.deepEqual(p.posted.filter((m) => m.type === 'send').map(assertedMessageBody), [
      { type: 'send', pid: 8, text: 'hello' }
    ]);
  });

  it('sends after reveal before the pid is on the board', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'hello');
    enter(p);
    answerOpen(p, 8, 8_000);
    assert.deepEqual(p.posted.filter((m) => m.type === 'send').map(assertedMessageBody), [
      { type: 'send', pid: 8, text: 'hello' }
    ]);
    p.push(stateMessage(board([cardView({ pid: 8, startedAt: 8_000, owned: true })]), extra));
    assert.equal(p.posted.filter((m) => m.type === 'send').length, 1);
  });

  it('sends in the background without stealing selection', (t) => {
    const other = cardView({ pid: 3, startedAt: 3_000, owned: true });
    const p = openPanel(t);
    p.push(stateMessage(board([other]), extra));
    newDraft(p, CWD);
    typeIn(p, 'in flight');
    enter(p);
    p.window.document.querySelector<HTMLElement>('.card[data-pid="3"]')?.click();
    answerOpen(p, 8, 8_000);
    assert.ok(p.posted.some((m) => m.type === 'send' && m.pid === 8));
    assert.ok(
      !p.posted.some((m) => m.type === 'select' && m.pid === 8),
      'background bind stole selection'
    );
  });

  it('does not put a file pick that settles during start onto the first send', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'hello');
    clip(p).click();
    enter(p);
    answerFilePick(p, ['/tmp/late.ts']);
    answerOpen(p, 8, 8_000);
    const sent = lastSend(p);
    assert.equal((assertedMessageBody(sent) as { text: string }).text, 'hello');
    assert.ok(!String(sent.text).includes('/tmp/late.ts'));
  });

  it('ignores a duplicate reveal', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'once');
    enter(p);
    const openMsg = lastOpen(p);
    answerOpen(p, 8, 8_000);
    p.push({
      type: 'reveal',
      pid: 8,
      startedAt: 8_000,
      draftId: openMsg.draftId
    });
    assert.equal(p.posted.filter((m) => m.type === 'send').length, 1);
  });

  it('refuses the first send without overwriting later typing', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'first');
    enter(p);
    answerOpen(p, 8, 8_000);
    p.push(
      stateMessage(board([cardView({ pid: 8, startedAt: 8_000, owned: true })]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: true })
      })
    );
    typeIn(p, 'newer');
    answerSend(p, { ok: false, reason: 'session is gone' });
    assert.equal(composerValue(p), 'newer');
    assert.equal(p.window.document.getElementById('blocked')?.textContent, 'session is gone');
  });

  it('keeps an explicit workflow on the first send', (t) => {
    const armed = {
      workflows: [workflowView({ id: 'ship', label: 'plan→build→review' })]
    };
    const p = openPanel(t);
    p.push(stateMessage(board(), armed));
    newDraft(p, CWD);
    attachWorkflow(p, 'plan→build→review');
    enter(p);
    answerOpen(p, 8, 8_000);
    assert.equal((assertedMessageBody(lastSend(p)) as { workflowId?: string }).workflowId, 'ship');
    p.push(
      stateMessage(board([cardView({ pid: 8, startedAt: 8_000, owned: true })]), {
        ...armed,
        thread: threadView({ pid: 8, startedAt: 8_000 })
      })
    );
    assert.equal(p.posted.filter((m) => m.type === 'send').length, 1);
  });

  it('keeps a late file pick as the next message and sends it', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'hello');
    clip(p).click();
    enter(p);
    answerFilePick(p, ['/tmp/late.ts']);
    answerOpen(p, 8, 8_000);
    p.push(
      stateMessage(board([cardView({ pid: 8, startedAt: 8_000, owned: true })]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: true })
      })
    );
    assert.equal((assertedMessageBody(lastSend(p)) as { text: string }).text, 'hello');
    assert.match(composerValue(p), /\/tmp\/late\.ts/);
    enter(p);
    const sends = p.posted.filter((m) => m.type === 'send');
    assert.equal(sends.length, 2, 'the late pick was not a second send');
    assert.equal((assertedMessageBody(sends[1]) as { text: string }).text, '/tmp/late.ts');
  });

  it('keeps typing done on the spawned card before reveal', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'hello');
    enter(p);
    const started = cardView({ pid: 8, startedAt: 8_000, owned: true });
    p.push(stateMessage(board([started]), extra));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="8"]')?.click();
    p.push(
      stateMessage(board([started]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: true })
      })
    );
    typeIn(p, 'on the card');
    answerOpen(p, 8, 8_000);
    assert.equal((assertedMessageBody(lastSend(p)) as { text: string }).text, 'hello');
    assert.equal(composerValue(p), 'on the card');
    enter(p);
    const sends = p.posted.filter((m) => m.type === 'send');
    assert.equal(sends.length, 2);
    assert.equal((assertedMessageBody(sends[1]) as { text: string }).text, 'on the card');
  });

  it('keeps a file pick done on the spawned card before reveal', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'hello');
    enter(p);
    const started = cardView({ pid: 8, startedAt: 8_000, owned: true, fullCwd: CWD });
    p.push(stateMessage(board([started]), extra));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="8"]')?.click();
    clip(p).click();
    answerFilePick(p, ['/tmp/card.ts']);
    answerOpen(p, 8, 8_000);
    assert.equal((assertedMessageBody(lastSend(p)) as { text: string }).text, 'hello');
    p.push(
      stateMessage(board([started]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: true, fullCwd: CWD })
      })
    );
    assert.match(composerValue(p), /\/tmp\/card\.ts/);
    enter(p);
    const sends = p.posted.filter((m) => m.type === 'send');
    assert.equal(sends.length, 2, 'the card pick was not a second send');
    assert.equal((assertedMessageBody(sends[1]) as { text: string }).text, '/tmp/card.ts');
  });

  it('keeps a later same-basename pick as the next send', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    clip(p).click();
    answerFilePick(p, ['/tmp/first/same.ts']);
    clip(p).click();
    enter(p);
    answerFilePick(p, ['/tmp/next/same.ts']);
    answerOpen(p, 8, 8_000);
    p.push(
      stateMessage(board([cardView({ pid: 8, startedAt: 8_000, owned: true })]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: true })
      })
    );
    assert.equal((assertedMessageBody(lastSend(p)) as { text: string }).text, '/tmp/first/same.ts');
    assert.match(composerValue(p), /\/tmp\/next\/same\.ts/);
    enter(p);
    const sends = p.posted.filter((m) => m.type === 'send');
    assert.equal(sends.length, 2, 'the later same-basename pick was not a second send');
    assert.equal((assertedMessageBody(sends[1]) as { text: string }).text, '/tmp/next/same.ts');
  });

  it('keeps both same-basename picks when the card is selected before reveal', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'hello');
    clip(p).click();
    enter(p);
    answerFilePick(p, ['/tmp/draft/same.ts']);
    const started = cardView({ pid: 8, startedAt: 8_000, owned: true, fullCwd: CWD });
    p.push(stateMessage(board([started]), extra));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="8"]')?.click();
    p.push(
      stateMessage(board([started]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: true, fullCwd: CWD })
      })
    );
    clip(p).click();
    answerFilePick(p, ['/tmp/card/same.ts']);
    answerOpen(p, 8, 8_000);
    assert.equal((assertedMessageBody(lastSend(p)) as { text: string }).text, 'hello');
    enter(p);
    const sends = p.posted.filter((m) => m.type === 'send');
    assert.equal(sends.length, 2);
    const next = (assertedMessageBody(sends[1]) as { text: string }).text;
    assert.match(next, /\/tmp\/draft\/same\.ts/, 'draft-side path was lost');
    assert.match(next, /\/tmp\/card\/same\.ts/, 'card-side path was lost');
  });

  it('does not rewrite a longer file token when merging same-basename picks', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'hello');
    clip(p).click();
    enter(p);
    answerFilePick(p, ['/tmp/draft/a.ts']);
    const started = cardView({ pid: 8, startedAt: 8_000, owned: true, fullCwd: CWD });
    p.push(stateMessage(board([started]), extra));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="8"]')?.click();
    p.push(
      stateMessage(board([started]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: true, fullCwd: CWD })
      })
    );
    clip(p).click();
    answerFilePick(p, ['/tmp/card/a.ts', '/tmp/other/a.ts.bak']);
    answerOpen(p, 8, 8_000);
    assert.equal((assertedMessageBody(lastSend(p)) as { text: string }).text, 'hello');
    enter(p);
    const sends = p.posted.filter((m) => m.type === 'send');
    assert.equal(sends.length, 2);
    const next = (assertedMessageBody(sends[1]) as { text: string }).text;
    assert.match(next, /\/tmp\/draft\/a\.ts/);
    assert.match(next, /\/tmp\/card\/a\.ts/);
    assert.match(next, /\/tmp\/other\/a\.ts\.bak/);
    assert.doesNotMatch(next, /\/tmp\/card\/a\.ts\.bak/);
  });

  it('shows a workflow-only held retry and sends that workflow', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    attachWorkflow(p, 'plan→build→review');
    enter(p);
    const first = lastOpen(p).draftId;
    assert.ok(first);
    p.push({
      type: 'openResult',
      draftId: first,
      outcome: 'stopped',
      notice: 'That session did not start.'
    });
    const row = p.window.document.querySelector('[data-act="retry-held"]')?.closest('.send-failed');
    assert.match(row?.textContent ?? '', /plan→build→review/);
    assert.equal(p.window.document.querySelector('#wattach .wflow.armed'), null);
    retryHeld(p);
    answerOpen(p, 8, 8_000);
    assert.equal((assertedMessageBody(lastSend(p)) as { workflowId?: string }).workflowId, 'ship');
  });

  it('retries a visible held snapshot without sending a typed replacement', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'original');
    clip(p).click();
    enter(p);
    const first = lastOpen(p).draftId;
    assert.ok(first);
    answerFilePick(p, ['/tmp/late.ts']);
    p.push({
      type: 'openResult',
      draftId: first,
      outcome: 'stopped',
      notice: 'That session did not start.'
    });
    assert.match(composerValue(p), /\/tmp\/late\.ts/);
    assert.ok(
      p.window.document.querySelector('[data-act="retry-held"]'),
      'held original was not shown for retry'
    );
    typeIn(p, 'replacement');
    const opens = p.posted.filter((m) => m.type === 'open').length;
    enter(p);
    assert.equal(
      p.posted.filter((m) => m.type === 'open').length,
      opens,
      'Enter retried the hidden original'
    );
    retryHeld(p);
    assert.equal(lastOpen(p).placeholder, 'original');
    assert.equal(composerValue(p), 'replacement');
    answerOpen(p, 8, 8_000);
    p.push(
      stateMessage(board([cardView({ pid: 8, startedAt: 8_000, owned: true })]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: true })
      })
    );
    assert.equal((assertedMessageBody(lastSend(p)) as { text: string }).text, 'original');
    assert.equal(composerValue(p), 'replacement');
    enter(p);
    const sends = p.posted.filter((m) => m.type === 'send');
    assert.equal(sends.length, 2);
    assert.equal((assertedMessageBody(sends[1]) as { text: string }).text, 'replacement');
  });

  it('refuses an unavailable first delivery without stealing later text', (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'first');
    enter(p);
    const started = cardView({ pid: 8, startedAt: 8_000, owned: true });
    p.push(stateMessage(board([started]), extra));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="8"]')?.click();
    p.push(
      stateMessage(board([started]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: false })
      })
    );
    answerOpen(p, 8, 8_000);
    assert.equal(
      p.posted.filter((m) => m.type === 'send').length,
      0,
      'unavailable first delivery still posted send'
    );
    assert.ok(
      p.window.document.querySelector('[data-act="retry-held"]'),
      'held first message was not shown for retry'
    );
    p.push(
      stateMessage(board([started]), {
        ...extra,
        thread: threadView({ pid: 8, startedAt: 8_000, owned: true, canSend: true })
      })
    );
    typeIn(p, 'second');
    enter(p);
    const sends = p.posted.filter((m) => m.type === 'send');
    assert.equal(sends.length, 1);
    assert.equal((assertedMessageBody(sends[0]) as { text: string }).text, 'second');
    retryHeld(p);
    const after = p.posted.filter((m) => m.type === 'send');
    assert.equal(after.length, 2);
    assert.equal((assertedMessageBody(after[1]) as { text: string }).text, 'first');
  });

  const giveUp = async (p: Panel): Promise<void> => {
    const real = p.window.Date.now;
    p.window.Date.now = () => real() + 25_001;
    await new Promise((done) => setTimeout(done, 1200));
    p.window.Date.now = real;
  };

  it('retries the held first message after a confirmed stop, keeping later compose', async (t) => {
    const p = openPanel(t);
    p.push(stateMessage(board(), extra));
    newDraft(p, CWD);
    typeIn(p, 'original');
    clip(p).click();
    enter(p);
    const first = lastOpen(p).draftId;
    answerFilePick(p, ['/tmp/late.ts']);
    await giveUp(p);
    assert.ok(first);
    p.push({
      type: 'startupStatus',
      attemptId: first,
      state: 'stopped',
      notice: 'Session start stopped.'
    });
    retryHeld(p);
    assert.notEqual(lastOpen(p).draftId, first, 'timeout retry reused the retired attempt');
    answerOpen(p, 9, 9_000);
    assert.equal((assertedMessageBody(lastSend(p)) as { text: string }).text, 'original');
    p.push(
      stateMessage(board([cardView({ pid: 9, startedAt: 9_000, owned: true })]), {
        ...extra,
        thread: threadView({ pid: 9, startedAt: 9_000, owned: true, canSend: true })
      })
    );
    assert.match(composerValue(p), /\/tmp\/late\.ts/);
    enter(p);
    const sends = p.posted.filter((m) => m.type === 'send');
    assert.equal(sends.length, 2, 'the late pick was not a second send after timeout retry');
    assert.equal((assertedMessageBody(sends[1]) as { text: string }).text, '/tmp/late.ts');
  });
});
