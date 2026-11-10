import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkoutLabel } from '../../ui/text';
import {
  Panel,
  cardView,
  enter,
  groupView,
  lastOpen,
  openPanel,
  stateMessage,
  typeIn
} from '../harness';

/** A conversation as the host sends one, with only what a case is about set. */
const conversationView = (over: Partial<ConversationView> = {}): ConversationView => ({
  sessionId: 'abc',
  brand: 'claude',
  title: 'Measure board columns',
  titled: true,
  lastActivity: Date.now() - 60_000,
  branch: 'staging',
  cwd: '/dev/app',
  ...over
});

/** A board with one group and its add slot, which is where resume starts. */
const board = (
  t: Parameters<typeof openPanel>[0],
  over: Partial<StateMessage> = {},
  cwd = '/dev/app'
): Panel => {
  const p = openPanel(t);
  p.push(stateMessage([groupView({ cwd, sessions: [] })], over));
  return p;
};

/** The `resume` the picker posted. Narrowed by the assertion itself — `equal`
 *  carries an `asserts` signature — so a case reads one field of it without the
 *  union's other variants in the way. */
const posted = (p: Panel): Extract<WebviewMessage, { type: 'resume' }> => {
  const last = p.posted.at(-1);
  assert.equal(last?.type, 'resume', 'the picker posted no resume');
  return last;
};

const halves = (p: Panel): HTMLElement[] => [
  ...p.window.document.querySelectorAll<HTMLElement>('.card.add .half')
];

const rows = (p: Panel): HTMLElement[] => [
  ...p.window.document.querySelectorAll<HTMLElement>('.pit')
];

type ListConversations = Extract<WebviewMessage, { type: 'listConversations' }>;

/** The picker's last ask for conversations. */
const asked = (p: Panel): ListConversations => {
  const last = [...p.posted].reverse().find((m) => m.type === 'listConversations');
  assert.ok(last?.type === 'listConversations', 'the picker asked for no conversations');
  return last;
};

const asks = (p: Panel): ListConversations[] =>
  p.posted.filter((m): m is ListConversations => m.type === 'listConversations');

/** The host's answer to the picker's last ask: page 1 of snapshot `snap-1`
 *  unless that ask carried a cursor, whose place it answers. */
const answer = (
  p: Panel,
  rows: ConversationView[],
  over: Partial<ConversationsMessage> = {}
): void => {
  const ask = asked(p);
  p.push({
    type: 'conversations',
    requestId: ask.requestId,
    cwd: ask.cwd,
    snapshotId: ask.cursor?.snapshotId ?? 'snap-1',
    offset: ask.cursor?.offset ?? 0,
    rows,
    ...over
  });
};

/** `n` rows, newest first, keyed `<prefix>0`…; distinct titles for search cases. */
const many = (n: number, prefix = 'r', from = 0): ConversationView[] =>
  Array.from({ length: n }, (_, i) =>
    conversationView({
      sessionId: `${prefix}${from + i}`,
      title: `Row ${prefix}${from + i}`,
      lastActivity: Date.now() - (from + i + 1) * 60_000
    })
  );

const keys = (p: Panel): (string | undefined)[] =>
  rows(p).map((r) => r.querySelector('.t')?.textContent ?? undefined);

const more = (p: Panel): HTMLElement | null => p.window.document.querySelector('.pmore');

const filterBox = (p: Panel): HTMLInputElement =>
  p.window.document.getElementById('pfilter') as HTMLInputElement;

const typeQuery = (p: Panel, text: string): void => {
  filterBox(p).value = text;
  filterBox(p).dispatchEvent(new p.window.Event('input', { bubbles: true }));
};

const key = (p: Panel, name: string): void => {
  p.window.document
    .getElementById('picker')
    ?.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: name, bubbles: true }));
};

const openPicker = (p: Panel, cwd = '/dev/app'): void => {
  halves(p)
    .find((h) => h.dataset.act === 'resume')
    ?.click();
  answer(p, [conversationView()], { cwd });
};

describe('the add slot', () => {
  it('offers both a resume and a new session, in that order', (t) => {
    const p = board(t);
    assert.deepEqual(
      halves(p).map((h) => h.dataset.act),
      ['resume', 'open']
    );
  });

  it('opens a draft from the second half, and starts nothing yet', (t) => {
    const p = board(t);
    halves(p)[1]?.click();
    assert.deepEqual(p.posted, [], 'New spawned before there was anything to say');

    // The send is what starts it, and it starts here: since row 71 a start is
    // always this window's, so the slot carries a folder and no window.
    typeIn(p, 'begin');
    enter(p);
    const open = lastOpen(p);
    assert.equal(open.cwd, '/dev/app');
    assert.equal('windowId' in open, false, 'the open still names a window');
  });

  it('asks for the folder’s conversations from the first, and starts nothing', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    const requestId = asked(p).requestId;
    assert.ok(requestId);
    assert.deepEqual(p.posted, [{ type: 'listConversations', requestId, cwd: '/dev/app' }]);
  });
});

describe('the resume picker', () => {
  it('returns focus to the Resume control that opened it', (t) => {
    const p = board(t);
    const opener = halves(p).find((h) => h.dataset.act === 'resume');
    assert.ok(opener);
    opener.focus();
    assert.equal(p.window.document.activeElement, opener, 'Resume cannot take focus');
    opener.click();
    assert.equal(p.window.document.activeElement, filterBox(p), 'the picker took focus');
    key(p, 'Escape');
    assert.equal(p.window.document.getElementById('picker')?.hidden, true);
    assert.equal(p.window.document.activeElement, opener);
  });

  it('reconciles an uncertain resume without offering a competing retry', (t) => {
    const p = board(t);
    openPicker(p);
    rows(p)[0]?.click();
    const request = posted(p);
    p.push({
      type: 'resumeResult',
      requestId: request.requestId,
      outcome: 'unknown',
      notice: 'Opening outcome unknown.'
    });
    assert.equal(p.window.document.querySelector('[data-act="retry-resume"]'), null);
    openPicker(p);
    rows(p)[0]?.click();
    assert.equal(
      p.posted.filter((message) => message.type === 'resume').length,
      1,
      'selecting the uncertain conversation created a competing resume'
    );
    const check = p.window.document.querySelector<HTMLButtonElement>(
      '.resuming [data-startup="status"]'
    );
    assert.ok(check);
    check.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'startup',
      attemptId: request.requestId,
      action: 'status'
    });
    p.push({
      type: 'startupStatus',
      attemptId: request.requestId,
      state: 'stopped',
      notice: 'The session stopped.'
    });
    assert.ok(p.window.document.querySelector('[data-act="retry-resume"]'));
  });
  it('keeps internal startup stage names out of pending feedback', (t) => {
    const p = board(t);
    openPicker(p);
    rows(p)[0]?.click();
    p.push({
      type: 'startupStatus',
      attemptId: posted(p).requestId,
      state: 'waiting',
      notice: 'Starting session…',
      stage: 'child identity'
    });
    const text = p.window.document.querySelector('.resuming')?.textContent ?? '';
    assert.match(text, /Starting session/);
    assert.doesNotMatch(text, /child identity/);
  });
  it('reconciles a resume retained by the host after the original panel closed', (t) => {
    const p = board(t);
    openPicker(p);
    rows(p)[0]?.click();
    const request = posted(p);
    p.push({
      type: 'resumeResult',
      requestId: request.requestId,
      attemptId: 'original-resume',
      outcome: 'unknown',
      notice: 'The earlier resume is still stopping.'
    });
    p.window.document
      .querySelector<HTMLButtonElement>('.resuming [data-startup="status"]')
      ?.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'startup',
      attemptId: 'original-resume',
      action: 'status'
    });
    p.push({
      type: 'startupStatus',
      attemptId: 'original-resume',
      state: 'stopped',
      notice: 'That session did not start.'
    });
    assert.ok(p.window.document.querySelector('[data-act="retry-resume"]'));
  });
  it('says it is reading before the host answers', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    assert.equal(p.window.document.getElementById('picker')?.hidden, false);
    assert.match(
      p.window.document.querySelector('.pnote')?.textContent ?? '',
      /Reading this folder/
    );
  });

  it('draws a row per conversation, with its age and branch', (t) => {
    const p = board(t);
    openPicker(p);
    const [row] = rows(p);
    assert.equal(row?.querySelector('.t')?.textContent, 'Measure board columns');
    assert.match(row?.querySelector('.m')?.textContent ?? '', /1m ago/);
    assert.match(row?.querySelector('.m')?.textContent ?? '', /staging/);
  });

  it('marks a prompt standing in for a title', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [conversationView({ title: 'now do the websocket client', titled: false })]);
    const [row] = rows(p);
    assert.ok(row?.querySelector('.t')?.classList.contains('said'), 'untitled row not marked');
    // And it is not offered as the resumed session's name — `--name` should not
    // restate a prompt as though the CLI had titled the conversation. It rides
    // as the label instead, so the card reads like a fresh one rather than
    // `agent-3f` while the CLI works out a title.
    row?.click();
    const posted = p.posted.at(-1) as { name?: string; placeholder?: string };
    assert.equal(posted.name, undefined);
    assert.equal(posted.placeholder, 'now do the websocket client');
  });

  it('offers a stated name as a name, since that is what it is', (t) => {
    // The one kind of title a row carries: `core/conversations.ts` reads every
    // other as a prompt standing in, so nothing a CLI guessed reaches `--name`
    // here and a resumed session goes on titling itself.
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [conversationView({ title: 'Own the stated name', titled: true })]);
    rows(p)[0]?.click();
    const posted = p.posted.at(-1) as { name?: string; placeholder?: string };
    assert.equal(posted.name, 'Own the stated name');
    assert.equal(posted.placeholder, undefined);
  });

  it('shows a running conversation rather than hiding it', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [conversationView({ running: true })]);
    assert.equal(rows(p)[0]?.querySelector('.now')?.textContent, 'running');
  });

  it('posts the resume for the row that is clicked, and closes', (t) => {
    const p = board(t);
    openPicker(p);
    rows(p)[0]?.click();
    // The title rides along as the name: `--name` is read at start and never
    // again, so a resumed card would otherwise be called after its directory.
    //
    // And the pick rides with it. A resume states what it starts on for the
    // same reason an `open` does: one place decides, and it is the message.
    // `''` here is the gear's setting, unset on this fixture board, which is
    // the account's own default said out loud.
    assert.deepEqual(p.posted.at(-1), {
      type: 'resume',
      requestId: posted(p).requestId,
      cwd: '/dev/app',
      sessionId: 'abc',
      name: 'Measure board columns',
      target: { brand: 'claude', model: '' }
    });
    assert.equal(p.window.document.getElementById('picker')?.hidden, true);
  });

  /**
   * The effort rides with the rest of the pick, for the reason the model does:
   * `startOwned` reads no setting, so a resume that stated nothing here would
   * silently start at the CLI's own default where it used to take the reader's.
   */
  it('states the effort the setting names', (t) => {
    const p = board(t, {
      model: 'opus',
      efforts: { opus: 'high', fable: 'low' },
      models: [
        {
          value: 'opus',
          name: 'Opus',
          id: 'claude-opus-5',
          brand: 'claude',
          window: 1_000_000,
          efforts: [{ value: 'medium' }, { value: 'high' }]
        }
      ]
    });
    openPicker(p);
    rows(p)[0]?.click();
    assert.equal(posted(p).target?.effort, 'high');
  });

  /** The effort is native to the selected model, so dropping a cross-brand
   *  model must drop its effort too. */
  it('drops an effort that belongs to another brand’s model', (t) => {
    const p = board(t, {
      model: 'opus',
      efforts: { opus: 'max' },
      models: [
        {
          value: 'opus',
          name: 'Opus',
          id: 'claude-opus-5',
          brand: 'claude',
          window: 1_000_000,
          efforts: [{ value: 'high' }, { value: 'max' }]
        },
        {
          value: 'grok-4.6',
          name: 'Grok 4.6',
          id: 'grok-4.6',
          brand: 'grok',
          window: 500_000,
          efforts: [{ value: 'high' }],
          defaultEffort: 'high'
        }
      ]
    });
    halves(p)[0]?.click();
    answer(p, [conversationView({ brand: 'grok' })]);
    rows(p)[0]?.click();
    const out = posted(p).target ?? {};
    assert.equal(out.model, '', 'a Claude model rode a Grok resume');
    assert.equal('effort' in out, false, 'a Claude-only effort rode a Grok resume');
  });

  /** Unset names nothing at all, rather than an empty string. */
  it('names no effort when the setting is unset', (t) => {
    const p = board(t);
    openPicker(p);
    rows(p)[0]?.click();
    assert.equal(
      'effort' in (posted(p).target ?? {}),
      false,
      'an unset setting still named an effort'
    );
  });

  it('resumes a sibling checkout in its own directory, and says which', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [conversationView({ cwd: '/dev/app/apps/web', where: 'apps/web' })]);
    assert.match(rows(p)[0]?.querySelector('.m')?.textContent ?? '', /apps\/web/);
    rows(p)[0]?.click();
    // The picker's folder would be the wrong one: the CLI finds a session id
    // only under the slug of the cwd it is run in.
    assert.equal((p.posted.at(-1) as { cwd?: string }).cwd, '/dev/app/apps/web');
  });

  it('paints the host Windows checkout leaf and resumes its raw directory', (t) => {
    const cwd = 'C:\\work\\App\\.worktrees\\ENG-42';
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [conversationView({ cwd, where: checkoutLabel('C:\\work\\App', cwd) })]);
    assert.match(rows(p)[0]?.querySelector('.m')?.textContent ?? '', /ENG-42/);
    assert.ok(!rows(p)[0]?.querySelector('.m')?.textContent?.includes('C:'));
    rows(p)[0]?.click();
    assert.equal(posted(p).cwd, cwd);
  });

  it('takes the row the arrows are resting on when Enter is pressed', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [
      conversationView({ sessionId: 'first' }),
      conversationView({ sessionId: 'second' })
    ]);
    const sheet = p.window.document.getElementById('picker');
    const key = (k: string): void => {
      sheet?.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
    };
    key('ArrowDown');
    key('Enter');
    assert.equal(
      (p.posted.at(-1) as { sessionId?: string } | undefined)?.sessionId,
      'second',
      'Enter took the wrong row'
    );
  });

  it('closes on Escape without starting anything', (t) => {
    const p = board(t);
    openPicker(p);
    const before = p.posted.length;
    p.window.document
      .getElementById('picker')
      ?.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(p.window.document.getElementById('picker')?.hidden, true);
    assert.equal(p.posted.length, before);
  });

  it('leaves the picker open when Escape belongs to IME composition', (t) => {
    const p = board(t);
    openPicker(p);
    const picker = p.window.document.getElementById('picker');
    const before = p.posted.length;
    for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
      picker?.dispatchEvent(
        new p.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
          ...extra
        })
      );
      assert.equal(picker?.hidden, false);
      assert.equal(p.posted.length, before);
    }
  });

  it('paints a brand mark on a Grok row', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [conversationView({ brand: 'grok', sessionId: 'g1', title: 'Load the session' })]);
    const [row] = rows(p);
    assert.ok(row?.querySelector('.bmwrap .bm.gr'), 'Grok row has no brand mark');
  });

  it('marks an already-running Codex row with its own brand', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [
      conversationView({
        brand: 'codex',
        sessionId: 'cx1',
        title: 'Continue the Codex thread',
        running: true
      })
    ]);
    const [row] = rows(p);
    assert.ok(row?.querySelector('.bmwrap .bm.cx'), 'Codex row has no brand mark');
    assert.equal(row?.querySelector('.now')?.textContent, 'running');
  });

  it('treats the same session id on two brands as two rows', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [
      conversationView({ sessionId: 'same', brand: 'claude', title: 'Claude turn' }),
      conversationView({ sessionId: 'same', brand: 'grok', title: 'Grok turn' })
    ]);
    const keys = rows(p).map((r) => r.dataset.key);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1], 'two brands collapsed to one key');
  });

  it('posts the row’s brand when a Grok row is pressed', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [conversationView({ brand: 'grok', sessionId: 'g1', title: 'Load the session' })]);
    rows(p)[0]?.click();
    assert.equal(posted(p).target?.brand, 'grok');
  });

  it('asks the host to search the open’s snapshot once typing pauses', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [
      conversationView({ sessionId: 'a', title: 'Measure board columns' }),
      conversationView({ sessionId: 'b', title: 'Probe the resume flag' })
    ]);
    const before = asks(p).length;
    typeQuery(p, 'resu');
    typeQuery(p, 'resume');
    t.mock.timers.tick(149);
    assert.equal(asks(p).length, before, 'searched before typing paused');
    t.mock.timers.tick(1);
    assert.equal(asks(p).length, before + 1, 'one search per pause');
    const ask = asked(p);
    assert.equal(ask.query, 'resume');
    assert.deepEqual(ask.cursor, { snapshotId: 'snap-1', offset: 0 });
    assert.notEqual(ask.requestId, asks(p)[0]?.requestId);
    answer(p, [conversationView({ sessionId: 'b', title: 'Probe the resume flag' })]);
    assert.deepEqual(
      rows(p).map((r) => r.dataset.key),
      ['claude\0b']
    );
  });

  it('says nothing matches only when the host found nothing', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = board(t);
    openPicker(p);
    typeQuery(p, 'grok');
    t.mock.timers.tick(150);
    answer(p, []);
    assert.equal(
      p.window.document.querySelector('.pnote')?.textContent,
      'No conversation matches that.'
    );
  });

  it('says the 30-day window is empty when the folder has no recent history', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, []);
    assert.match(
      p.window.document.querySelector('.pnote')?.textContent ?? '',
      /^No conversation in the last 30 days\.$/
    );
  });

  it('ignores an answer for a folder it is no longer asking about', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [conversationView()], { cwd: '/dev/elsewhere' });
    assert.equal(rows(p).length, 0, 'another folder’s conversations were drawn');
  });
});

describe('the resume picker’s pages', () => {
  it('asks for a fresh ranking on open and draws page 1 in the host’s order', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    const ask = asked(p);
    assert.ok(ask.requestId, 'the open carried no request id');
    assert.equal(ask.cursor, undefined, 'an open must rank afresh, not page an old snapshot');
    assert.equal(ask.query, undefined);
    // The host's page 1 keeps the asked-folder floor: an older row from the
    // asked folder sits among newer ones from a sibling checkout.
    const page = [
      ...many(19, 'sib'),
      conversationView({
        sessionId: 'here',
        title: 'Row here',
        lastActivity: Date.now() - 86_400_000
      })
    ];
    answer(p, page);
    assert.deepEqual(
      keys(p),
      page.map((r) => r.title)
    );
  });

  it('offers no older rows when the host says the list ends', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, many(5));
    assert.equal(more(p), null);
  });

  it('appends the next page without drawing a row twice', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, many(20), { next: { snapshotId: 'snap-1', offset: 20 } });
    assert.equal(more(p)?.textContent, 'Show older');
    more(p)?.click();
    const ask = asked(p);
    assert.deepEqual(ask.cursor, { snapshotId: 'snap-1', offset: 20 });
    assert.equal(ask.query, undefined);
    // `r19` again: the de-duplication guard behind the snapshot's own.
    answer(p, [...many(1, 'r', 19), ...many(3, 'r', 20)]);
    assert.deepEqual(
      keys(p),
      many(23).map((r) => r.title)
    );
    assert.equal(more(p), null);
  });

  it('loads the next page when the arrows walk past the last row', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, many(2), { next: { snapshotId: 'snap-1', offset: 2 } });
    const before = asks(p).length;
    key(p, 'ArrowDown');
    assert.equal(asks(p).length, before, 'walking onto the last row loaded a page');
    key(p, 'ArrowDown');
    assert.equal(asks(p).length, before + 1, 'walking past the last row loaded no page');
    assert.deepEqual(asked(p).cursor, { snapshotId: 'snap-1', offset: 2 });
    key(p, 'ArrowDown');
    assert.equal(asks(p).length, before + 1, 'a page already asked for was asked again');
    answer(p, many(1, 'r', 2));
    assert.equal(p.window.document.querySelector('.pit.on .t')?.textContent, 'Row r2');
    key(p, 'Enter');
    assert.equal(posted(p).sessionId, 'r2');
  });

  it('keeps the highlighted row when Show older is clicked', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, many(20), { next: { snapshotId: 'snap-1', offset: 20 } });
    key(p, 'ArrowDown');
    key(p, 'ArrowDown');
    more(p)?.click();
    answer(p, many(20, 'r', 20), { next: { snapshotId: 'snap-1', offset: 40 } });
    assert.equal(rows(p).length, 40);
    assert.equal(p.window.document.querySelector('.pit.on .t')?.textContent, 'Row r2');
    key(p, 'Enter');
    assert.equal(posted(p).sessionId, 'r2');
  });

  it('takes the first match of a search typed and entered before the host answered', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [
      conversationView({ sessionId: 'a', title: 'Measure board columns' }),
      conversationView({ sessionId: 'b', title: 'Probe the resume flag' })
    ]);
    const before = asks(p).length;
    typeQuery(p, 'probe');
    key(p, 'Enter');
    assert.equal(asks(p).length, before + 1, 'Enter left the search waiting for the pause');
    assert.equal(asked(p).query, 'probe');
    assert.ok(
      !p.posted.some((m) => m.type === 'resume'),
      'Enter resumed a row of the list the search replaces'
    );
    t.mock.timers.tick(150);
    assert.equal(asks(p).length, before + 1, 'the search Enter sent was sent again');
    answer(p, [conversationView({ sessionId: 'b', title: 'Probe the resume flag' })]);
    assert.equal(posted(p).sessionId, 'b');
  });

  it('waits on a search in flight, and takes nothing it did not find', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = board(t);
    openPicker(p);
    typeQuery(p, 'ledger');
    t.mock.timers.tick(150);
    key(p, 'Enter');
    assert.ok(!p.posted.some((m) => m.type === 'resume'), 'Enter took a row before the answer');
    answer(p, []);
    assert.ok(!p.posted.some((m) => m.type === 'resume'));
    assert.equal(
      p.window.document.querySelector('.pnote')?.textContent,
      'No conversation matches that.'
    );
    // Typing again withdraws an Enter that is still waiting.
    typeQuery(p, 'probe');
    key(p, 'Enter');
    typeQuery(p, 'probes');
    t.mock.timers.tick(150);
    answer(p, [conversationView({ sessionId: 'p', title: 'Probes' })]);
    assert.ok(!p.posted.some((m) => m.type === 'resume'), 'a withdrawn Enter still resumed');
  });

  it('forgets a waiting Enter when the picker closes, so the next open takes nothing', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = board(t);
    openPicker(p);
    typeQuery(p, 'probe');
    key(p, 'Enter');
    key(p, 'Escape');
    openPicker(p);
    assert.equal(rows(p).length, 1, 'the reopened picker drew no row to take');
    assert.ok(!p.posted.some((m) => m.type === 'resume'), 'a closed picker’s Enter still resumed');
  });

  it('withdraws a waiting Enter when an arrow is pressed', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = board(t);
    openPicker(p);
    typeQuery(p, 'probe');
    key(p, 'Enter');
    key(p, 'ArrowDown');
    answer(p, many(2));
    assert.equal(rows(p).length, 2);
    assert.ok(!p.posted.some((m) => m.type === 'resume'), 'a withdrawn Enter still resumed');
  });

  it('presses the highlighted row while a page is only being appended', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, many(20), { next: { snapshotId: 'snap-1', offset: 20 } });
    key(p, 'ArrowDown');
    more(p)?.click();
    assert.equal(asked(p).cursor?.offset, 20);
    key(p, 'Enter');
    assert.equal(posted(p).sessionId, 'r1');
  });

  it('carries a waiting Enter across an expired snapshot to the restarted answer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = board(t);
    openPicker(p);
    typeQuery(p, 'probe');
    key(p, 'Enter');
    answer(p, [], { expired: true });
    assert.equal(asked(p).query, 'probe');
    assert.ok(!p.posted.some((m) => m.type === 'resume'), 'Enter took a row before the restart');
    answer(p, [conversationView({ sessionId: 'p1', title: 'Probe the flag' })], {
      snapshotId: 'snap-2'
    });
    assert.equal(posted(p).sessionId, 'p1');
  });

  it('ignores a reply whose request or snapshot is not the one asked for', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, many(20), { next: { snapshotId: 'snap-1', offset: 20 } });
    answer(p, many(1, 'stale'), { requestId: 'an-older-ask', offset: 0 });
    assert.equal(rows(p).length, 20, 'a reply to another request was drawn');
    more(p)?.click();
    answer(p, many(1, 'other'), { snapshotId: 'snap-2' });
    assert.equal(rows(p).length, 20, 'a page of another snapshot was appended');
    answer(p, many(1, 'r', 20));
    assert.equal(rows(p).length, 21);
  });

  it('ignores a late reply to the picker it closed, though the folder is the same', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    const first = asked(p);
    key(p, 'Escape');
    halves(p)[0]?.click();
    assert.notEqual(asked(p).requestId, first.requestId);
    p.push({
      type: 'conversations',
      requestId: first.requestId,
      cwd: first.cwd,
      snapshotId: 'snap-0',
      offset: 0,
      rows: [conversationView()]
    });
    assert.equal(rows(p).length, 0, 'the closed picker’s reply was drawn');
    assert.match(p.window.document.querySelector('.pnote')?.textContent ?? '', /Reading/);
  });

  it('restarts at page 1 when the snapshot expired', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, many(20), { next: { snapshotId: 'snap-1', offset: 20 } });
    more(p)?.click();
    answer(p, [], { expired: true });
    const ask = asked(p);
    assert.equal(ask.cursor, undefined, 'an expired snapshot was paged again');
    assert.equal(ask.query, undefined);
    assert.equal(rows(p).length, 20, 'the list emptied while page 1 was read again');
    answer(p, many(2, 'fresh'), { snapshotId: 'snap-2' });
    assert.deepEqual(keys(p), ['Row fresh0', 'Row fresh1']);
  });

  it('keeps the search text and restarts at the query’s page 1 when the snapshot expired', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = board(t);
    openPicker(p);
    typeQuery(p, 'probe');
    t.mock.timers.tick(150);
    answer(p, [], { expired: true });
    const ask = asked(p);
    assert.equal(ask.cursor, undefined);
    assert.equal(ask.query, 'probe');
    assert.equal(filterBox(p).value, 'probe');
    answer(p, [conversationView({ sessionId: 'p1', title: 'Probe the flag' })], {
      snapshotId: 'snap-2'
    });
    assert.deepEqual(keys(p), ['Probe the flag']);
  });

  it('shows a match from beyond the loaded pages as its query’s first page', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, many(20), { next: { snapshotId: 'snap-1', offset: 20 } });
    typeQuery(p, 'ledger');
    t.mock.timers.tick(150);
    // One matched by its prompt, one by the name somebody stated for it; both
    // were on page 3, never loaded here.
    answer(
      p,
      [
        conversationView({ sessionId: 'deep1', title: 'Fix the ledger rounding', titled: false }),
        conversationView({ sessionId: 'deep2', title: 'Ledger export', titled: true })
      ],
      { next: { snapshotId: 'snap-1', offset: 2 } }
    );
    assert.deepEqual(keys(p), ['Fix the ledger rounding', 'Ledger export']);
    more(p)?.click();
    assert.deepEqual(asked(p).cursor, { snapshotId: 'snap-1', offset: 2 });
    assert.equal(asked(p).query, 'ledger', 'the next page of a search lost its query');
  });

  it('drops a late reply to an earlier query', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = board(t);
    openPicker(p);
    typeQuery(p, 'a');
    t.mock.timers.tick(150);
    const first = asked(p);
    typeQuery(p, 'ab');
    t.mock.timers.tick(150);
    p.push({
      type: 'conversations',
      requestId: first.requestId,
      cwd: first.cwd,
      snapshotId: 'snap-1',
      offset: 0,
      rows: [conversationView({ sessionId: 'late', title: 'Late a' })]
    });
    assert.deepEqual(keys(p), ['Measure board columns'], 'the earlier query’s reply was drawn');
    answer(p, [conversationView({ sessionId: 'ab', title: 'Matches ab' })]);
    assert.deepEqual(keys(p), ['Matches ab']);
  });

  it('restores the unfiltered page 1 when the query is cleared', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, many(20), { next: { snapshotId: 'snap-1', offset: 20 } });
    typeQuery(p, 'r1');
    t.mock.timers.tick(150);
    answer(p, many(1, 'r', 1));
    typeQuery(p, '');
    t.mock.timers.tick(150);
    const ask = asked(p);
    assert.equal(ask.query, undefined, 'a cleared box still searched');
    assert.deepEqual(ask.cursor, { snapshotId: 'snap-1', offset: 0 });
    answer(p, many(20), { next: { snapshotId: 'snap-1', offset: 20 } });
    assert.equal(rows(p).length, 20);
    assert.ok(more(p));
  });

  it('marks a running row on page 2, and pressing it asks for that conversation', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, many(20), { next: { snapshotId: 'snap-1', offset: 20 } });
    more(p)?.click();
    assert.deepEqual(asked(p).cursor, { snapshotId: 'snap-1', offset: 20 });
    answer(p, [conversationView({ sessionId: 'live', title: 'Still running', running: true })]);
    assert.equal(rows(p).length, 21);
    const row = rows(p).find((r) => r.dataset.key === 'claude\0live');
    assert.equal(row?.querySelector('.now')?.textContent, 'running');
    row?.click();
    // The host answers a running conversation by revealing its card.
    assert.equal(posted(p).sessionId, 'live');
  });

  it('ends at 500 loaded rows with no row in place of Show older', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, many(20), { next: { snapshotId: 'snap-1', offset: 20 } });
    for (let offset = 20; offset < 500; offset += 20) {
      more(p)?.click();
      answer(
        p,
        many(20, 'r', offset),
        offset + 20 < 500 ? { next: { snapshotId: 'snap-1', offset: offset + 20 } } : {}
      );
    }
    assert.equal(rows(p).length, 500);
    assert.equal(more(p), null);
    assert.equal(p.window.document.querySelector('.pnote'), null);
  });

  it('gives a query its own list under the same limit', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, many(20), { next: { snapshotId: 'snap-1', offset: 20 } });
    typeQuery(p, 'row');
    t.mock.timers.tick(150);
    answer(p, many(20, 'q'), { next: { snapshotId: 'snap-1', offset: 20 } });
    assert.deepEqual(
      keys(p),
      many(20, 'q').map((r) => r.title),
      'a new query kept the old rows'
    );
    for (let offset = 20; offset < 500; offset += 20) {
      more(p)?.click();
      answer(
        p,
        many(20, 'q', offset),
        offset + 20 < 500 ? { next: { snapshotId: 'snap-1', offset: offset + 20 } } : {}
      );
    }
    assert.equal(rows(p).length, 500);
    assert.equal(more(p), null);
  });
});

describe('resume startup feedback', () => {
  const pending = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector('.card.resuming');

  it('shows the conversation immediately and keeps it until the exact session appears', (t) => {
    const p = board(t);
    openPicker(p);
    rows(p)[0]?.click();
    assert.match(pending(p)?.textContent ?? '', /Measure board columns/);
    assert.match(pending(p)?.textContent ?? '', /Resuming/);
    assert.ok(pending(p)?.querySelector('.spinner'));
    assert.equal(pending(p)?.dataset.pid, undefined);
    const requestId = posted(p).requestId;
    assert.ok(requestId);
    const unrelated = cardView({ pid: 20, startedAt: 200 });
    const push = (sessions: CardView[]): void =>
      p.push(stateMessage([groupView({ cwd: '/dev/app', sessions })]));
    push([unrelated]);
    assert.ok(pending(p), 'an unrelated start cleared the resume');
    p.push({
      type: 'resumeResult',
      requestId,
      outcome: 'started',
      notice: 'Session started.',
      pid: 21,
      startedAt: 300
    });
    push([unrelated, cardView({ pid: 21, startedAt: 100 })]);
    assert.ok(pending(p), 'a different incarnation cleared the resume');
    push([unrelated, cardView({ pid: 21, startedAt: 300 })]);
    assert.equal(pending(p), null);
  });

  it('shows refusal, retries with a new id, ignores stale results and can dismiss failure', (t) => {
    const p = board(t);
    openPicker(p);
    rows(p)[0]?.click();
    const first = posted(p);
    p.push({
      type: 'resumeResult',
      requestId: first.requestId,
      outcome: 'stopped',
      notice: 'Sign in first.'
    });
    assert.match(pending(p)?.textContent ?? '', /Sign in first/);
    assert.equal(pending(p)?.querySelector('.spinner'), null);
    pending(p)?.querySelector<HTMLButtonElement>('[data-act="retry-resume"]')?.click();
    const retry = posted(p);
    assert.notEqual(retry.requestId, first.requestId);
    assert.equal(retry.sessionId, first.sessionId);
    p.push({
      type: 'resumeResult',
      requestId: first.requestId,
      outcome: 'stopped',
      notice: 'Old refusal'
    });
    assert.ok(pending(p)?.querySelector('.spinner'));
    assert.doesNotMatch(pending(p)?.textContent ?? '', /Old refusal/);
    p.push({
      type: 'resumeResult',
      requestId: retry.requestId,
      outcome: 'stopped',
      notice: 'Still signed out.'
    });
    pending(p)?.querySelector<HTMLButtonElement>('[data-act="dismiss-resume"]')?.click();
    assert.equal(pending(p), null);
  });

  it('keeps feedback in the picker group while resuming the row’s own checkout', (t) => {
    const p = board(t);
    halves(p)[0]?.click();
    answer(p, [conversationView({ cwd: '/dev/other' })]);
    rows(p)[0]?.click();
    assert.equal(posted(p).cwd, '/dev/other');
    assert.equal(pending(p)?.closest<HTMLElement>('.grid')?.dataset.cwd, '/dev/app');
    openPicker(p);
    rows(p)[0]?.click();
    assert.equal(p.posted.filter((msg) => msg.type === 'resume').length, 1);
    assert.equal(p.window.document.querySelectorAll('.card.resuming').length, 1);
  });

  it('removes feedback for a running row whose existing card is already present', (t) => {
    const p = board(t);
    const existing = cardView({ pid: 21, startedAt: 300 });
    p.push(stateMessage([groupView({ cwd: '/dev/app', sessions: [existing] })]));
    openPicker(p);
    rows(p)[0]?.click();
    p.push({
      type: 'resumeResult',
      requestId: posted(p).requestId,
      outcome: 'started',
      notice: 'Session started.',
      pid: 21,
      startedAt: 300
    });
    assert.equal(pending(p), null);
    assert.ok(p.window.document.querySelector('.card[data-pid="21"]'));
  });

  it('preserves an unsent draft while showing resume feedback', (t) => {
    const p = board(t);
    halves(p)[1]?.click();
    typeIn(p, 'keep this draft');
    openPicker(p);
    rows(p)[0]?.click();
    p.push({
      type: 'resumeResult',
      requestId: posted(p).requestId,
      outcome: 'stopped',
      notice: 'No binary.'
    });
    assert.match(p.window.document.getElementById('input')?.textContent ?? '', /keep this draft/);
    assert.equal(p.posted.filter((msg) => msg.type === 'open').length, 0);
  });
});

/**
 * What a resume runs on, which used to be `squadron.model` read at the far
 * end and is now stated on the message the picker posts.
 */
describe('the pick a resume carries', () => {
  /** Open the picker on a board offering two brands, and press the one row it
   *  is given — a conversation of `brand`, which is what the pick is measured
   *  against. */
  const resumed = (p: Panel, brand: BrandId = 'grok'): WebviewMessage | undefined => {
    halves(p)
      .find((h) => h.dataset.act === 'resume')
      ?.click();
    answer(p, [conversationView({ brand, sessionId: 'g1' })]);
    rows(p)[0]?.click();
    return p.posted.at(-1);
  };

  const MODELS: ModelView[] = [
    { value: 'opus', name: 'Opus', id: 'opus', brand: 'claude', window: 1_000_000 },
    { value: 'grok-4.6', name: 'Grok 4.6', id: 'grok-4.6', brand: 'grok', window: 500_000 }
  ];

  /**
   * `''` — the account's own default, said out loud.
   *
   * The picker has no model control of its own, so an unset gear is the answer
   * it states. Taking the catalog's top-ranked row on the reader's behalf would
   * pin a conversation to a model it had never run on, decided by a ranking
   * nobody read.
   */
  it('states the account default when the gear is unset', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ cwd: '/dev/app', sessions: [] })], { models: MODELS }));
    const sent = resumed(p);
    assert.equal(sent?.type, 'resume');
    // The row's own brand still rides, which is what decides the CLI.
    assert.equal(sent?.type === 'resume' ? sent.target?.brand : undefined, 'grok');
    assert.equal(sent?.type === 'resume' ? sent.target?.model : undefined, '');
    assert.equal(sent?.type === 'resume' ? sent.target?.window : undefined, undefined);
  });

  /**
   * A gear that *is* set is what the resume passes — the setting says what a
   * new session starts on, and a resume is a start.
   *
   * Verbatim, and not resolved against the list the way the draft's pill
   * resolves it: there is no pill here for a reader to see the resolution on.
   */
  it('states the gear’s setting when there is one', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ cwd: '/dev/app', sessions: [] })], {
        models: MODELS,
        model: 'opus',
        contextWindow: 1_000_000
      })
    );
    const sent = resumed(p, 'claude');
    assert.equal(sent?.type === 'resume' ? sent.target?.model : undefined, 'opus');
    assert.equal(sent?.type === 'resume' ? sent.target?.window : undefined, 1_000_000);
  });

  /**
   * **A default of another brand is dropped, not passed.** The one thing this
   * path may not do is send a pair the host will refuse.
   *
   * `startOwned` read the gear here once and dropped a cross-brand id itself;
   * it refuses the pair now (`checkSpawnIdentity`), and a refusal on this path
   * reaches nobody — the picker has shut, there is no card to carry the
   * sentence, and host toasts are muted. So a reader whose `Default model` is a
   * Grok row would find every Claude resume doing nothing at all, with no way
   * to find out why. This is the behaviour that shipped, restated where the
   * pick is now made.
   */
  it('drops a default that belongs to another brand', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ cwd: '/dev/app', sessions: [] })], {
        models: MODELS,
        model: 'grok-4.6',
        contextWindow: 500_000
      })
    );
    const sent = resumed(p, 'claude');
    assert.equal(sent?.type === 'resume' ? sent.target?.brand : undefined, 'claude');
    assert.equal(sent?.type === 'resume' ? sent.target?.model : undefined, '');
    assert.equal(
      sent?.type === 'resume' ? sent.target?.window : undefined,
      undefined,
      'the dropped model left its window behind'
    );
  });

  /** The same drop for an id no list names: `brandForModel` places a `grok-`
   *  spelling, so a typed Grok id is dropped from a Claude resume too. */
  it('drops an unlisted default whose id names another brand', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ cwd: '/dev/app', sessions: [] })], {
        models: MODELS,
        model: 'grok-9'
      })
    );
    const sent = resumed(p, 'claude');
    assert.equal(sent?.type === 'resume' ? sent.target?.model : undefined, '');
  });

  /** And an unlisted id that names no brand rides: it is Claude's by default,
   *  which is the brand a resume of a Claude conversation wants. */
  it('passes an unlisted default that names no brand', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ cwd: '/dev/app', sessions: [] })], {
        models: MODELS,
        model: 'claude-opus-4-5'
      })
    );
    const sent = resumed(p, 'claude');
    assert.equal(sent?.type === 'resume' ? sent.target?.model : undefined, 'claude-opus-4-5');
  });
});
