import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cardView,
  groupView,
  openPanel,
  remoteStateView,
  stateMessage,
  switchLabel,
  switchedOn
} from '../harness';
import type { Panel } from '../harness';

/**
 * Keep-awake: its word on the bottom hub, and the mode of the sheet that
 * word opens. The hold arrives merged on `StateMessage.awake` and the two
 * switches on `cafe` and `cafeRemote`; the words are `ui/awake_rows.ts`. These
 * scenarios hold what the word and the sheet draw from them, what a press
 * posts, and how the frame shuts.
 */

const $ = (p: Panel, sel: string): HTMLElement | null =>
  p.window.document.querySelector<HTMLElement>(sel);

const word = (p: Panel): HTMLElement => {
  const node = $(p, '#bottomhub .awake-tab');
  assert.ok(node, 'no Keep-awake word on the bottom hub');
  return node;
};
const dot = (p: Panel): HTMLElement => {
  const node = word(p).querySelector<HTMLElement>('.dot');
  assert.ok(node, 'the Keep-awake word carries no dot');
  return node;
};

const board = () => [groupView({ sessions: [cardView({ pid: 1 })] })];
const MIN = 60_000;

type Over = {
  awake?: AwakeView;
  cafe?: boolean;
  cafeRemote?: boolean;
  cafeWarm?: boolean;
  warmOn?: boolean;
  remote?: RemoteStateView;
};
function push(p: Panel, over: Over = {}): void {
  const { awake, remote, cafe = true, cafeRemote = true, cafeWarm = true } = over;
  p.push(
    stateMessage(board(), {
      cafe,
      cafeRemote,
      cafeWarm,
      warmOn: over.warmOn ?? false,
      ...(awake ? { awake } : {}),
      ...(remote ? { remote } : {})
    })
  );
}

/** Open Keep-awake from shut. The bar is not a control while the sheet is up. */
function open(p: Panel): HTMLElement {
  const sheet = $(p, '#bottomdrawer');
  if (sheet && !sheet.hidden) $(p, '#bottomdrawer-close')?.click();
  word(p).click();
  const opened = $(p, '#bottomdrawer');
  assert.ok(opened && !opened.hidden, 'Keep-awake opened no sheet');
  return opened;
}

const master = (sheet: HTMLElement) => {
  const node = sheet.querySelector<HTMLElement>('.bdlist .awake-now');
  assert.ok(node, 'no Keep awake switch');
  return {
    node,
    head: node.querySelector('.head')?.textContent,
    left: node.querySelector('.left')?.textContent ?? '',
    detail: node.querySelector('.d')?.textContent
  };
};
const toggle = (sheet: HTMLElement, label: string): HTMLElement => {
  const found = [...sheet.querySelectorAll<HTMLElement>('.bdlist [role="switch"]')].find(
    (r) => switchLabel(r) === label
  );
  assert.ok(found, `no "${label}" switch`);
  return found;
};
const MASTER = 'Keep awake';
const REMOTE = 'Stay awake while Remote is on';
const WARM = 'Stay awake while Warm is on';

describe('Keep-awake on the bottom hub', () => {
  it('is a live word that opens its own mode of the sheet', (t) => {
    const p = openPanel(t);
    push(p, { awake: { reason: 'idle' } });
    assert.equal(word(p).getAttribute('aria-disabled'), null);
    assert.equal(word(p).textContent, 'Keep-awake');
    const sheet = open(p);
    assert.ok(sheet.classList.contains('awake'));
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Keep-awake');
    const note = p.window.document.getElementById('bottomdrawer-note');
    assert.equal(note?.hidden, false);
    assert.equal(
      note?.textContent,
      'Keep this Mac awake while a session works. The Mac still sleeps when you close the lid.'
    );
    assert.equal(note?.parentElement?.id, 'bottomdrawer-head', 'the note sits in the header');
    assert.equal(word(p).getAttribute('aria-expanded'), 'true');
  });

  it('lights its dot while held, warns it while refused, and leaves it clear otherwise', (t) => {
    const p = openPanel(t);
    push(p, { awake: { reason: 'drinking', until: Date.now() + 5 * MIN, sessions: 1 } });
    assert.ok(dot(p).classList.contains('on'));
    push(p, { awake: { reason: 'stale' } });
    assert.ok(dot(p).classList.contains('held'));
    assert.ok(!dot(p).classList.contains('on'));
    push(p, { awake: { reason: 'idle' } });
    assert.ok(!dot(p).classList.contains('on') && !dot(p).classList.contains('held'));
  });

  it('returns the focus to the word when the sheet shuts', (t) => {
    const p = openPanel(t);
    push(p, { awake: { reason: 'idle' } });
    open(p);
    p.window.document.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.ok($(p, '#bottomdrawer')?.hidden);
    assert.equal(p.window.document.activeElement, word(p));
  });
});

describe('Keep-awake’s master switch', () => {
  it('carries the state on its title line, labelled by its name alone', (t) => {
    const p = openPanel(t);
    push(p, { awake: { reason: 'drinking', until: Date.now() + 5 * MIN, sessions: 1 } });
    const sheet = open(p);
    const now = master(sheet);
    assert.equal(now.node, toggle(sheet, MASTER));
    assert.ok(now.node.querySelector('.t .head'), 'the state is not on the title line');
    assert.equal(now.node.getAttribute('aria-label'), MASTER);
    assert.equal(now.detail, 'Kept awake for 1 session. Applies to every window.');
  });

  it('says how many sessions it holds for, and how long the lease has left', (t) => {
    const p = openPanel(t);
    push(p, { awake: { reason: 'drinking', until: Date.now() + 6 * MIN + 30_000, sessions: 2 } });
    const now = master(open(p));
    assert.equal(now.head, 'Awake');
    assert.equal(now.detail, 'Kept awake for 2 sessions. Applies to every window.');
    assert.equal(now.left, '7 min left');
    assert.equal(now.node.dataset.tone, 'on');
    const fill = now.node.querySelector<HTMLElement>('.bar i');
    assert.ok(fill, 'no lease bar while held');
  });

  it('says Remote is holding when no session is', (t) => {
    const p = openPanel(t);
    push(p, {
      awake: { reason: 'drinking', until: Date.now() + 9 * MIN, sessions: 0, remote: true },
      remote: remoteStateView({ on: true, tone: 'live', status: 'Connected' })
    });
    assert.equal(master(open(p)).head, 'Awake for Remote');
  });

  it('says Warm is holding when no session is', (t) => {
    const p = openPanel(t);
    push(p, {
      awake: { reason: 'drinking', until: Date.now() + 9 * MIN, sessions: 0, warmSessions: 1 }
    });
    const now = master(open(p));
    assert.equal(now.head, 'Awake for Warm');
    assert.equal(
      now.detail,
      "Nothing working · awake so 1 session's cache stays warm. Applies to every window."
    );
  });

  it('warns when Warm is on and its hold is off', (t) => {
    const p = openPanel(t);
    push(p, { awake: { reason: 'idle' }, cafeWarm: false, warmOn: true });
    const now = master(open(p));
    assert.equal(
      now.detail,
      'Warm is on, nothing working · may sleep and miss a ping. Applies to every window.'
    );
    assert.equal(now.node.dataset.tone, 'held');
  });

  it('warns when Remote is on and its hold is off', (t) => {
    const p = openPanel(t);
    push(p, {
      awake: { reason: 'idle' },
      cafeRemote: false,
      remote: remoteStateView({ on: true, tone: 'live', status: 'Connected' })
    });
    const now = master(open(p));
    assert.equal(
      now.detail,
      'Remote is on, nothing working · may sleep and miss messages. Applies to every window.'
    );
    assert.equal(now.node.dataset.tone, 'held');
    assert.equal(now.node.querySelector('.bar'), null, 'a bar with nothing held');
  });

  it('still warns after a turn-on here is refused because another window holds Remote', (t) => {
    const p = openPanel(t);
    push(p, {
      awake: { reason: 'idle' },
      cafeRemote: false,
      remote: remoteStateView({
        on: false,
        onSomewhere: true,
        tone: 'fault',
        status: 'On in another window: api',
        refused: 'Remote is on in api. Turn it off there first.'
      })
    });
    const now = master(open(p));
    assert.equal(
      now.detail,
      'Remote is on, nothing working · may sleep and miss messages. Applies to every window.'
    );
    assert.equal(now.node.dataset.tone, 'held');
  });

  it('reads Off with the setting off', (t) => {
    const p = openPanel(t);
    push(p, { cafe: false });
    const now = master(open(p));
    assert.equal(now.head, 'Off');
    assert.equal(now.left, '');
  });
});

describe('Keep-awake’s switches', () => {
  it('turns keep-awake off, and holds the flip until a push agrees', (t) => {
    const p = openPanel(t);
    push(p, { awake: { reason: 'idle' } });
    const sheet = open(p);
    const master = toggle(sheet, MASTER);
    assert.equal(switchedOn(master), true);
    master.click();
    assert.deepEqual(p.posted.at(-1), { type: 'setFlag', key: 'cafe', on: false });
    assert.equal(switchedOn(toggle(sheet, MASTER)), false);
    push(p, { awake: { reason: 'idle' } });
    assert.equal(switchedOn(toggle(sheet, MASTER)), false, 'a stale push put it back');
    push(p, { cafe: false });
    assert.equal(switchedOn(toggle(sheet, MASTER)), false);
    push(p, { awake: { reason: 'idle' } });
    assert.equal(switchedOn(toggle(sheet, MASTER)), true, 'the host turned it back on');
  });

  it('puts keep-awake back when the host could not write the setting', (t) => {
    const p = openPanel(t);
    push(p, { awake: { reason: 'idle' } });
    const sheet = open(p);
    toggle(sheet, MASTER).click();
    assert.equal(switchedOn(toggle(sheet, MASTER)), false);
    p.push({ type: 'flagChoice', key: 'cafe', on: false, landed: false });
    assert.equal(
      switchedOn(toggle(sheet, MASTER)),
      true,
      'a refused write left the flip on screen'
    );
  });

  it('turns the Remote hold off', (t) => {
    const p = openPanel(t);
    push(p, { awake: { reason: 'idle' } });
    const sheet = open(p);
    const remote = toggle(sheet, REMOTE);
    assert.equal(switchedOn(remote), true);
    remote.click();
    assert.deepEqual(p.posted.at(-1), { type: 'setFlag', key: 'cafeRemote', on: false });
    assert.equal(switchedOn(toggle(sheet, REMOTE)), false);
  });

  it('turns the Warm hold off, and holds the flip until a push agrees', (t) => {
    const p = openPanel(t);
    push(p, { awake: { reason: 'idle' } });
    const sheet = open(p);
    const warm = toggle(sheet, WARM);
    assert.equal(switchedOn(warm), true);
    warm.click();
    assert.deepEqual(p.posted.at(-1), { type: 'setFlag', key: 'cafeWarm', on: false });
    assert.equal(switchedOn(toggle(sheet, WARM)), false);
    push(p, { awake: { reason: 'idle' } });
    assert.equal(switchedOn(toggle(sheet, WARM)), false, 'a stale push put it back');
    push(p, { awake: { reason: 'idle' }, cafeWarm: false });
    assert.equal(switchedOn(toggle(sheet, WARM)), false);
    push(p, { awake: { reason: 'idle' } });
    assert.equal(switchedOn(toggle(sheet, WARM)), true, 'the host turned it back on');
  });

  it('greys the Warm hold while keep-awake is off, and posts nothing from it', (t) => {
    const p = openPanel(t);
    push(p, { cafe: false });
    const sheet = open(p);
    const warm = toggle(sheet, WARM);
    assert.equal(warm.getAttribute('aria-disabled'), 'true');
    const posts = p.posted.length;
    warm.click();
    assert.equal(p.posted.length, posts);
  });

  it('greys the Remote hold while keep-awake is off, and posts nothing from it', (t) => {
    const p = openPanel(t);
    push(p, { cafe: false });
    const sheet = open(p);
    const remote = toggle(sheet, REMOTE);
    assert.equal(remote.getAttribute('aria-disabled'), 'true');
    const posts = p.posted.length;
    remote.click();
    assert.equal(p.posted.length, posts);
  });
});

describe('Keep-awake’s configuration', () => {
  it('states the three figures and the fixed note, with each explanation in a tip', (t) => {
    const p = openPanel(t);
    push(p, { awake: { reason: 'idle' } });
    const sheet = open(p);
    const rows = [...sheet.querySelectorAll<HTMLElement>('.bddetail .awake-cfg')];
    assert.deepEqual(
      rows.map((r) => [
        r.querySelector('.label')?.textContent,
        r.querySelector<HTMLElement>('.label .why')?.dataset.tip,
        r.querySelector('.val')?.textContent
      ]),
      [
        [
          'After work stops',
          'The Mac stays awake this long after the last session stops working. The same limit applies if Squadron stops.',
          'up to 10 min'
        ],
        [
          'Silent session',
          'A working session that sends nothing for this long no longer keeps the Mac awake. Long builds and tests fit in this time.',
          '60 min'
        ],
        ['Battery below', 'On battery and below this level, nothing keeps the Mac awake.', '20%']
      ]
    );
    assert.equal(sheet.querySelector('.awake-cfg .detail'), null);
    assert.equal(
      sheet.querySelector('.awake-cfg-note')?.textContent,
      'You cannot change these values. Each window keeps the Mac awake for its own sessions. The Mac sleeps when no window does.'
    );
    assert.equal(sheet.querySelector('.bddetail input'), null);
  });

  it('puts the Remote and Warm switches’ explanations in a tip, and keeps the master’s inline', (t) => {
    const p = openPanel(t);
    push(p, { awake: { reason: 'idle' } });
    const sheet = open(p);
    const remote = toggle(sheet, REMOTE);
    const warm = toggle(sheet, WARM);
    assert.equal(
      remote.dataset.tip,
      'Keep the Mac awake with no session working, so messages from your phone arrive. This stops when Remote stops.'
    );
    assert.equal(
      warm.dataset.tip,
      'Keep the Mac awake with no session working, so pings arrive before the cache expires. This stops when Warm goes off.'
    );
    assert.equal(remote.getAttribute('aria-description'), remote.dataset.tip);
    assert.equal(warm.getAttribute('aria-description'), warm.dataset.tip);
    assert.equal(remote.querySelector('.d'), null);
    assert.equal(warm.querySelector('.d'), null);
    assert.ok(master(sheet).detail, 'the master switch lost its inline state');
  });
});
