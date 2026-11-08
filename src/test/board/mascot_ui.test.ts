import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import {
  assertedMessageBody,
  cardView,
  groupView,
  openPanel,
  permissionRequest,
  stateMessage,
  threadView,
  type Panel
} from '../harness';
import { COALESCE_MS, COOLDOWN_MS } from '../../ui/mascot';

/**
 * The chick on the board, as the panel draws it. jsdom has no layout and no
 * `Element.animate`, so every move here is the no-travel path: the chick lands
 * at once and shows its reaction. These scenarios assert where it perches and
 * which pose it holds, never coordinates — `smoke/mascot.smoke.ts` holds those.
 */

const chick = (p: Panel): HTMLElement | null => p.window.document.querySelector('#mascot');
const card = (pid: number, over: Partial<CardView> = {}): CardView =>
  cardView({ pid, status: 'busy', ...over });
const state = (
  sessions: CardView[],
  over: Partial<Omit<StateMessage, 'type' | 'groups'>> & { thread?: ThreadView } = {}
): StateMessage => stateMessage([groupView({ sessions })], { mascot: true, ...over });
const DONE = { word: 'done', tally: 'done' } as unknown as CardReading;

/** Where it sits and what it shows, in one comparable value. */
function seen(p: Panel): { perch?: string; pose?: string; pid?: string } {
  const el = chick(p);
  assert.ok(el, 'no chick on the board');
  return {
    perch: el.dataset.perch,
    pose: el.dataset.pose,
    ...(el.dataset.pid ? { pid: el.dataset.pid } : {})
  };
}

/**
 * A panel on a clock the test moves. The director reads `performance.now()`,
 * which is the window's own and not Node's, so it is pointed at Node's `Date`,
 * which the mock moves together with `setTimeout`.
 */
function clocked(t: TestContext): Panel {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const p = openPanel(t);
  Object.defineProperty(p.window.performance, 'now', { value: () => Date.now() });
  return p;
}

/** A panel with the chick on and two busy cards, on a clock the test moves. */
function board(t: TestContext): Panel {
  const p = clocked(t);
  p.push(state([card(1), card(2)]));
  return p;
}

/** Push, then let the coalesce window close. */
function decide(t: TestContext, p: Panel, msg: StateMessage): void {
  p.push(msg);
  t.mock.timers.tick(COALESCE_MS);
}

describe('the mascot switch', () => {
  it('mounts nothing while off, which is the default', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [card(1)] })]));
    assert.equal(chick(p), null);
  });

  it('sits on the bottom hub, standing, once switched on', (t) => {
    const p = openPanel(t);
    p.push(state([card(1)]));
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
    assert.equal(chick(p)?.querySelectorAll('canvas').length, 1, 'one drawn element');
  });

  it('is gone again when switched off', (t) => {
    const p = openPanel(t);
    p.push(state([card(1)]));
    p.push(state([card(1)], { mascot: false }));
    assert.equal(chick(p), null);
  });

  it('reacts to nothing on the push that switched it on', (t) => {
    const p = clocked(t);
    p.push(stateMessage([groupView({ sessions: [card(1)] })]));
    decide(t, p, state([card(1, { status: 'waiting' }), card(2)]));
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
  });
});

describe('the mascot and board facts', () => {
  it('flies to a card whose session opens a dialog, and goes alert', (t) => {
    const p = board(t);
    decide(t, p, state([card(1), card(2, { status: 'waiting' })]));
    assert.deepEqual(seen(p), { perch: 'card', pose: 'alert', pid: '2' });
  });

  it('waits out the coalesce before it moves', (t) => {
    const p = board(t);
    p.push(state([card(1), card(2, { status: 'waiting' })]));
    t.mock.timers.tick(COALESCE_MS - 1);
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
  });

  it('stands once the dialog is answered, and stays on the card', (t) => {
    const p = board(t);
    decide(t, p, state([card(1), card(2, { status: 'waiting' })]));
    p.push(state([card(1), card(2)]));
    assert.deepEqual(seen(p), { perch: 'card', pose: 'stand', pid: '2' });
  });

  it('celebrates a finished turn, then stands', (t) => {
    const p = board(t);
    decide(t, p, state([card(1, { status: 'idle', unread: DONE }), card(2)]));
    assert.deepEqual(seen(p), { perch: 'card', pose: 'happy', pid: '1' });
    t.mock.timers.tick(1400);
    assert.deepEqual(seen(p), { perch: 'card', pose: 'stand', pid: '1' });
  });

  it('greets a new card', (t) => {
    const p = board(t);
    decide(t, p, state([card(1), card(2), card(3)]));
    assert.deepEqual(seen(p), { perch: 'card', pose: 'happy', pid: '3' });
  });

  it('goes home once everything is idle', (t) => {
    const p = board(t);
    decide(t, p, state([card(1), card(2, { status: 'waiting' })]));
    t.mock.timers.tick(COOLDOWN_MS);
    decide(t, p, state([card(1, { status: 'idle' }), card(2, { status: 'idle' })]));
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
  });

  // In one swap: with no motion to run, the crouch it sinks through first is
  // a frame of motion too.
  it('sleeps where it is when the keep-awake hold ends', (t) => {
    const p = board(t);
    p.push(state([card(1), card(2)], { awake: { reason: 'drinking', until: 1, sessions: 1 } }));
    decide(t, p, state([card(1), card(2)], { awake: { reason: 'idle' } }));
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'sleep' });
  });

  it('goes home when the card it sits on leaves the board', (t) => {
    const p = board(t);
    decide(t, p, state([card(1), card(2, { status: 'waiting' })]));
    p.push(state([card(1)]));
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
  });

  it('makes one decision of a storm, and the dialog wins it', (t) => {
    const p = board(t);
    const finished = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((pid) =>
      card(pid, { status: 'idle', unread: DONE })
    );
    p.push(state([card(1), card(2), ...finished]));
    decide(t, p, state([card(1), card(2, { status: 'waiting' }), ...finished]));
    assert.deepEqual(seen(p), { perch: 'card', pose: 'alert', pid: '2' });
  });

  it('drops a finished turn read before the window closed', (t) => {
    const p = board(t);
    p.push(state([card(1, { status: 'idle', unread: DONE }), card(2)]));
    decide(t, p, state([card(1, { status: 'idle' }), card(2)]));
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
  });

  it('does not sleep for a hold that came back inside the window', (t) => {
    const p = board(t);
    const drinking: AwakeView = { reason: 'drinking', until: 1, sessions: 1 };
    p.push(state([card(1), card(2)], { awake: drinking }));
    p.push(state([card(1), card(2)], { awake: { reason: 'idle' } }));
    decide(t, p, state([card(1), card(2)], { awake: drinking }));
    t.mock.timers.tick(200);
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
  });

  it('sits home while the panel is hidden, and nothing moves it', (t) => {
    const p = board(t);
    p.push(state([card(1, { status: 'idle', unread: DONE }), card(2)]));
    t.mock.timers.tick(COALESCE_MS);
    p.push({ type: 'visible', visible: false });
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
    decide(
      t,
      p,
      state([card(1, { status: 'idle', unread: DONE }), card(2, { status: 'waiting' })])
    );
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
  });

  it('leaves nothing behind when switched off mid-reaction', (t) => {
    const p = board(t);
    decide(t, p, state([card(1, { status: 'idle', unread: DONE }), card(2)]));
    p.push(state([card(1, { status: 'idle', unread: DONE }), card(2)], { mascot: false }));
    t.mock.timers.tick(COOLDOWN_MS + COALESCE_MS);
    assert.equal(chick(p), null);
  });
});

describe('the mascot in Tickets', () => {
  const view = (p: Panel, name: string): void => {
    const tab = p.window.document.querySelector<HTMLElement>(`#nav [data-act="${name}"]`);
    assert.ok(tab);
    tab.click();
  };

  it('leaves its card for home and ignores session events until Sessions returns', async (t) => {
    const p = board(t);
    decide(t, p, state([card(1), card(2, { status: 'waiting' })]));
    view(p, 'tickets');
    await Promise.resolve();
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
    t.mock.timers.tick(COOLDOWN_MS);
    decide(t, p, state([card(1, { status: 'idle', unread: DONE }), card(2)]));
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
    view(p, 'sessions');
    await Promise.resolve();
    t.mock.timers.tick(COALESCE_MS);
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
    decide(t, p, state([card(1), card(2, { status: 'waiting' })]));
    assert.deepEqual(seen(p), { perch: 'card', pose: 'alert', pid: '2' });
  });

  it('drops a queued reaction and keeps the drawer perch while Tickets is open', async (t) => {
    const p = board(t);
    p.push(state([card(1), card(2, { status: 'waiting' })]));
    view(p, 'tickets');
    await Promise.resolve();
    t.mock.timers.tick(COALESCE_MS);
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
    p.window.document.querySelector<HTMLElement>('#bottomhub .warm-tab')?.click();
    await Promise.resolve();
    assert.deepEqual(seen(p), { perch: 'sheet', pose: 'stand' });
    decide(t, p, state([card(1, { status: 'idle', unread: DONE }), card(2)]));
    assert.deepEqual(seen(p), { perch: 'sheet', pose: 'stand' });
    p.window.document.querySelector<HTMLElement>('#bottomdrawer-close')?.click();
    await Promise.resolve();
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
    p.posted.length = 0;
    chick(p)?.click();
    assert.deepEqual(p.posted, []);
  });
});

describe('the mascot and the bottom drawer', () => {
  const warm = (p: Panel): void =>
    p.window.document.querySelector<HTMLElement>('#bottomhub .warm-tab')?.click();
  const shut = (p: Panel): void =>
    p.window.document.querySelector<HTMLElement>('#bottomdrawer-close')?.click();

  it('perches on the sheet when it opens, and goes home when it shuts', async (t) => {
    const p = board(t);
    warm(p);
    await Promise.resolve();
    assert.deepEqual(seen(p), { perch: 'sheet', pose: 'stand' });
    shut(p);
    await Promise.resolve();
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
  });

  it('reacts on the sheet rather than flying behind it', async (t) => {
    const p = board(t);
    warm(p);
    await Promise.resolve();
    decide(t, p, state([card(1, { status: 'idle', unread: DONE }), card(2)]));
    assert.deepEqual(seen(p), { perch: 'sheet', pose: 'happy' });
  });

  it('stays on its card through a push that leaves the sheet shut', async (t) => {
    const p = board(t);
    decide(t, p, state([card(1), card(2, { status: 'waiting' })]));
    p.push(state([card(1), card(2, { status: 'waiting' })]));
    await Promise.resolve();
    assert.deepEqual(seen(p), { perch: 'card', pose: 'alert', pid: '2' });
  });
});

describe('clicking the mascot', () => {
  it('opens a waiting card with its dialog up', (t) => {
    const thread = threadView({ status: 'waiting', pending: [permissionRequest()] });
    const p = board(t);
    decide(
      t,
      p,
      state([card(1), card(thread.pid, { startedAt: thread.startedAt, status: 'waiting' })])
    );
    p.posted.length = 0;
    chick(p)?.click();
    assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'select', pid: thread.pid }]);
    assert.equal(seen(p).pose, 'happy');
    p.push(
      state([card(1), card(thread.pid, { startedAt: thread.startedAt, status: 'waiting' })], {
        thread
      })
    );
    assert.equal(p.window.document.querySelector('#ask')?.hasAttribute('hidden'), false);
  });

  it('selects the card it celebrated', (t) => {
    const p = board(t);
    decide(t, p, state([card(1, { status: 'idle', unread: DONE }), card(2)]));
    t.mock.timers.tick(1400);
    p.posted.length = 0;
    chick(p)?.click();
    assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'select', pid: 1 }]);
    assert.equal(seen(p).pose, 'happy');
  });

  it('only chirps at home', (t) => {
    const p = board(t);
    p.posted.length = 0;
    chick(p)?.click();
    assert.deepEqual(p.posted, []);
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'happy' });
    t.mock.timers.tick(1400);
    assert.deepEqual(seen(p), { perch: 'bar', pose: 'stand' });
  });
});
