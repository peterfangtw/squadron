import * as slackMessenger from '../../core/slack/messenger';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { panelStylesheet } from '../../ui/document';
import * as remoteView from '../../ui/remote_view';
import type { CheckState, RemoteLink } from '../../core/remote/link';
import {
  cardView,
  groupView,
  openPanel,
  remoteStateView,
  stateMessage,
  switchedOn,
  workflowView
} from '../harness';
import type { Panel } from '../harness';

/**
 * Remote: its word on the bottom hub, and the mode of the sheet that word
 * opens. Every word arrives decided on `StateMessage.remote`
 * (`ui/remote_view.ts`); these scenarios hold what the word and the sheet
 * draw from it, what a press posts, and how the frame shuts. Whether five
 * words fit the bar, and the host's half, is `remote_panel.smoke.ts`.
 */

const $ = (p: Panel, sel: string): HTMLElement | null =>
  p.window.document.querySelector<HTMLElement>(sel);

const word = (p: Panel): HTMLElement => {
  const node = $(p, '#bottomhub .remote-tab');
  assert.ok(node, 'no Remote word on the bottom hub');
  return node;
};
const dot = (p: Panel): HTMLElement => {
  const node = word(p).querySelector<HTMLElement>('.dot');
  assert.ok(node, 'the Remote word carries no dot');
  return node;
};

const board = () => [groupView({ sessions: [cardView({ pid: 1 })] })];
const steps = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    label: `Step ${i + 1}`,
    prompt: `do step ${i + 1}`
  }));
const WORKFLOWS = [workflowView({ id: 'ship', label: 'plan→build', steps: steps(2) })];

function push(p: Panel, remote?: RemoteStateView, workflows = WORKFLOWS): void {
  p.push(stateMessage(board(), { workflows, ...(remote ? { remote } : {}) }));
}

/** Open Remote from shut. The bar is not a control while the sheet is up. */
function open(p: Panel): HTMLElement {
  const sheet = $(p, '#bottomdrawer');
  if (sheet && !sheet.hidden) $(p, '#bottomdrawer-close')?.click();
  word(p).click();
  const opened = $(p, '#bottomdrawer');
  assert.ok(opened && !opened.hidden, 'Remote opened no sheet');
  return opened;
}

const toggle = (sheet: HTMLElement): HTMLElement => {
  const row = sheet.querySelector<HTMLElement>('.bdlist [role="switch"]');
  assert.ok(row, 'no Remote switch in the list column');
  return row;
};
/** The link's word, which the selected messenger's row wears. */
const linkWord = (sheet: Element): string =>
  sheet.querySelector('.bdlist .messengers .drilled .val')?.textContent ?? '';
const buttons = (root: Element, text: string): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('button')].filter((b) => b.textContent === text);
const escape = (p: Panel): void => {
  p.window.document.dispatchEvent(
    new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  );
};
/** One of the setup column's sections: setup, tokens, allowed, interactions. */
const section = (detail: Element, name: string): HTMLElement => q(detail, `.sect.${name}`);
const messengers = (sheet: Element): HTMLElement[] => [
  ...sheet.querySelectorAll<HTMLElement>('.bdlist .messengers .mrow')
];
const label = (row: Element): string => row.querySelector('.t')?.textContent ?? '';
const press = (root: Element, text: string): void => {
  const found = buttons(root, text)[0];
  assert.ok(found, `no ${text} button`);
  found.click();
};
const guide = (p: Panel): HTMLElement | null => $(p, '#gscrim');
/** Open the guide from the setup column, and return the sheet it opened. */
function openGuide(p: Panel, sheet: HTMLElement): HTMLElement {
  press(section(q(sheet, '.bddetail'), 'setup'), 'Guide');
  const scrim = guide(p);
  assert.ok(scrim && !scrim.hidden, 'Guide opened no sheet');
  return q(scrim, '.asheet');
}

const SLACKLIKE: Omit<RemoteStateView['messengers'], 'state'> = {
  rows: [
    { id: 'slack', label: 'Slack', live: true },
    { id: 'discord', label: 'Discord', live: false, tip: 'Not supported yet (D29).' },
    { id: 'telegram', label: 'Telegram', live: false, tip: 'Not supported yet (D28).' }
  ],
  selected: 'slack'
};

describe('the Remote word on the bottom hub', () => {
  it('wears a dot in the tone the host decided, with the status as its tip', (t) => {
    const p = openPanel(t);
    const cases: [RemoteStateView['tone'], boolean, string][] = [
      ['pending', true, 'Connecting…'],
      ['live', true, 'Connected'],
      ['fault', true, 'Not connected'],
      ['elsewhere', false, 'On in another window: app']
    ];
    for (const [tone, on, status] of cases) {
      push(p, remoteStateView({ tone, on, status }));
      assert.equal(dot(p).className, `dot ${tone}`, tone);
      assert.match(word(p).dataset.tip ?? '', new RegExp(`^${status}`), tone);
    }
    push(p, remoteStateView());
    assert.equal(dot(p).className, 'dot', 'off draws no tone');
    assert.equal(word(p).dataset.tip, 'Off');
  });

  it('names the holder window’s folder in the tip', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        tone: 'elsewhere',
        status: 'On in another window: app',
        holderPath: '/w/app'
      })
    );
    assert.match(word(p).dataset.tip ?? '', /On in another window: app/);
    assert.match(word(p).dataset.tip ?? '', /\/w\/app/);
  });

  it('is drawn off when the host sends no Remote, and still opens', (t) => {
    const p = openPanel(t);
    push(p);
    assert.equal(dot(p).className, 'dot');
    assert.equal(word(p).getAttribute('aria-disabled'), null);
    assert.equal(word(p).dataset.tip, 'Remote is not available in this window.');
    const sheet = open(p);
    assert.match(sheet.querySelector('.bdlist')?.textContent ?? '', /not available in this window/);
    assert.equal(sheet.querySelector('.bdlist [role="switch"]'), null);
  });
});

describe('Remote on the bottom drawer', () => {
  // jsdom lays nothing out, so the column cap is read off the stylesheet.
  // A hardcoded grid would ignore a mode's tracks, and Remote's list would
  // grow again past the messengers.
  it('caps the messenger column and lets setup take the rest', () => {
    const css = panelStylesheet().replace(/\/\*[\s\S]*?\*\//g, '');
    const block = (head: string): string => {
      const at = css.indexOf(head);
      assert.ok(at >= 0, head);
      return css.slice(at, css.indexOf('}', at) + 1);
    };
    const tracks = 'grid-template-columns: var(--bd-list) var(--bd-detail)';
    assert.ok(block('#bottomdrawer-body {').includes(tracks));
    assert.ok(block('#bottomdrawer-find {').includes(tracks));
    const sheet = css.match(/#bottomdrawer \{[^}]*--bd-list:[^}]*\}/)?.[0] ?? '';
    assert.match(sheet, /--bd-list: minmax\(0, 1fr\)/);
    assert.match(sheet, /--bd-detail: minmax\(0, 44%\)/);
    const remote = css.match(/#bottomdrawer\.remote \{[^}]*--bd-list:[^}]*\}/)?.[0] ?? '';
    assert.match(remote, /--bd-list: min\(260px, 42%\)/);
    assert.match(remote, /--bd-detail: minmax\(0, 1fr\)/);
  });

  it('opens from its own word with a head, a note and columns of its own', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const sheet = open(p);
    assert.ok(sheet.classList.contains('remote'));
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Remote');
    const note = $(p, '#bottomdrawer-note');
    assert.equal(note?.hidden, false);
    assert.equal(note?.textContent, 'Remote control your agents from messenger apps.');
    assert.equal(sheet.querySelector('.wsrow'), null, 'workflow rows under Remote');
    assert.equal($(p, '#bottomdrawer-filter')?.hidden, true);
    assert.equal($(p, '#bottomdrawer-foot')?.hidden, true);
    assert.equal(word(p).getAttribute('aria-expanded'), 'true');
    assert.ok(toggle(sheet));
  });

  it('opens on a machine with no workflows, beside + New workflow', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView(), []);
    assert.match($(p, '#bottomhub')?.textContent ?? '', /\+ New workflow/);
    const sheet = open(p);
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Remote');
    assert.ok(toggle(sheet));
  });

  it('keeps drawing Remote while it slides shut, and Warm and Workflows reopen as themselves', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    $(p, '#bottomhub .warm-tab')?.click();
    $(p, '#bottomdrawer-close')?.click();
    const sheet = open(p);
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Remote');
    assert.equal(sheet.querySelector('.ttl-field'), null, 'Warm’s configuration under Remote');
    assert.equal(sheet.querySelector('.sessions'), null, 'Warm’s sessions under Remote');
    assert.ok(!sheet.classList.contains('warm'));

    $(p, '#bottomdrawer-close')?.click();
    assert.ok(sheet.hidden);
    assert.ok(sheet.classList.contains('remote'), 'closing dropped Remote’s chrome mid-slide');
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Remote');

    $(p, '#bottomhub .warm-tab')?.click();
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Warm');
    assert.ok(sheet.querySelector('.sessions'));
    assert.equal(sheet.querySelector('[data-key^="remote:"]'), null);
    assert.ok(!sheet.classList.contains('remote'));

    $(p, '#bottomdrawer-close')?.click();
    open(p);
    $(p, '#bottomdrawer-close')?.click();
    $(p, '#bottomhub .wmore')?.click();
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Workflows');
    assert.equal($(p, '#bottomdrawer-note')?.hidden, false);
    assert.match($(p, '#bottomdrawer-note')?.textContent ?? '', /^Compose a workflow/);
    assert.equal(sheet.querySelector('[data-key^="remote:"]'), null);
    assert.ok(!sheet.classList.contains('remote'));
    assert.ok(sheet.querySelector('.wsrow'));
  });

  it('posts the flipped switch and holds it until a push agrees', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const sheet = open(p);
    toggle(sheet).click();
    assert.deepEqual(p.posted, [{ type: 'setRemote', on: true }]);
    assert.equal(switchedOn(toggle(sheet)), true);

    push(p, remoteStateView());
    assert.equal(switchedOn(toggle(sheet)), true, 'a push from before the press took the flip');
    p.push({ type: 'remoteChoice', on: true, landed: true });
    push(p, remoteStateView());
    assert.equal(
      switchedOn(toggle(sheet)),
      true,
      'the answer retired the flip before a push agreed'
    );

    push(p, remoteStateView({ on: true, tone: 'pending', status: 'Connecting…' }));
    assert.equal(switchedOn(toggle(sheet)), true);
    push(p, remoteStateView());
    assert.equal(switchedOn(toggle(sheet)), false, 'an agreed flip outlived its push');
  });

  it('retires the flip on pushes that land while Remote is shut', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    toggle(open(p)).click();
    escape(p);
    p.push({ type: 'remoteChoice', on: true, landed: true });
    push(p, remoteStateView({ on: true, tone: 'pending', status: 'Connecting…' }));
    // The last allowed account removed in settings: the host turns Remote off.
    push(p, remoteStateView({ missing: ['an allowed account'], setup: { allowlist: [] } }));
    assert.equal(switchedOn(toggle(open(p))), false, 'the switch outlived the host turning off');
  });

  it('puts the switch back when the host refuses the turn-on', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const sheet = open(p);
    toggle(sheet).click();
    p.push({ type: 'remoteChoice', on: true, landed: false });
    assert.equal(switchedOn(toggle(sheet)), false);
    push(p, remoteStateView());
    assert.equal(switchedOn(toggle(sheet)), false);
    assert.equal(sheet.hidden, false);
  });

  it('keeps a newer off flip when an earlier turn-on is refused', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const sheet = open(p);
    toggle(sheet).click();
    toggle(sheet).click();
    assert.equal(switchedOn(toggle(sheet)), false);
    p.push({ type: 'remoteChoice', on: true, landed: false });
    push(p, remoteStateView({ on: true, tone: 'pending', status: 'Connecting…' }));
    assert.equal(switchedOn(toggle(sheet)), false, 'the refused turn-on retired the later flip');
    // A reply that still carries `on` used to be ignored, so the line above stayed green.
    p.push({ type: 'remoteChoice', on: false, landed: false });
    assert.equal(switchedOn(toggle(sheet)), true, 'refusing the later flip left the switch off');
  });

  it('names the window that holds Remote and leaves the switch pressable', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        tone: 'elsewhere',
        status: 'On in another window: app',
        holderPath: '/w/app'
      })
    );
    const sheet = open(p);
    const row = toggle(sheet);
    assert.equal(row.getAttribute('aria-disabled'), null);
    assert.match(linkWord(sheet), /On in another window: app/);
    row.click();
    assert.deepEqual(p.posted, [{ type: 'setRemote', on: true }]);
  });

  it('says a refused turn-on in the host’s words, with or without a holder', (t) => {
    const p = openPanel(t);
    const held = 'Remote is on in app. Turn it off there first.';
    push(p, remoteStateView({ tone: 'fault', refused: held }));
    const sheet = open(p);
    assert.equal(sheet.querySelector('.bdlist .remote-refused')?.textContent, held);
    const other = 'The bot token was refused.';
    push(p, remoteStateView({ tone: 'fault', refused: other }));
    assert.equal(sheet.querySelector('.bdlist .remote-refused')?.textContent, other);
    push(p, remoteStateView());
    assert.equal(sheet.querySelector('.bdlist .remote-refused'), null);
  });

  it('refuses the switch while setup is missing, and says so on the messenger, not the switch', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        missing: ['Bot token', 'an allowed account'],
        messengers: {
          ...SLACKLIKE,
          state: {
            tone: 'unset',
            text: 'Not configured',
            tip: 'Needs Bot token, an allowed account'
          }
        },
        setup: { fields: [{ key: 'bot', label: 'Bot token', set: false }], allowlist: [] }
      })
    );
    const sheet = open(p);
    const row = toggle(sheet);
    assert.equal(row.getAttribute('aria-disabled'), 'true');
    assert.equal(row.querySelector('.d'), null, 'the switch said more than its name');
    const slack = q(sheet, '.bdlist .messengers .drilled');
    assert.match(slack.textContent ?? '', /Not configured/);
    assert.ok(slack.querySelector('.mdot.unset'), 'Not configured wore another dot');
    assert.equal(slack.dataset.tip, 'Needs Bot token, an allowed account');
    row.click();
    assert.deepEqual(p.posted, []);
    assert.equal(switchedOn(row), false);
  });

  it('shows a failed link on the messenger, and its reason under the list', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        on: true,
        tone: 'fault',
        status: 'Not connected',
        reason: 'Socket Mode is off for this app.'
      })
    );
    const sheet = open(p);
    const list = q(sheet, '.bdlist');
    assert.match(linkWord(sheet), /Not connected/);
    assert.equal(
      list.querySelector('.remote-reason')?.textContent,
      'Socket Mode is off for this app.'
    );
  });

  it('turns the Remote hold back on from its warning', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        on: true,
        tone: 'live',
        status: 'Connected',
        warnings: [
          {
            text: 'Keep-awake does not hold for Remote, so this machine may sleep and miss messages.',
            fix: 'awakeRemote'
          }
        ]
      })
    );
    const sheet = open(p);
    const warn = sheet.querySelector<HTMLElement>('.bdlist .remote-warn');
    assert.ok(warn);
    assert.equal(buttons(warn, 'Keep awake').length, 0, 'the master switch is not the fix');
    const fix = buttons(warn, 'Stay awake')[0];
    assert.ok(fix, 'no Stay awake on the Remote-hold warning');
    fix.click();
    assert.deepEqual(p.posted, [{ type: 'setFlag', key: 'cafeRemote', on: true }]);
  });

  it('turns keep-awake on from the may-sleep warning, and offers no press for battery', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        on: true,
        tone: 'live',
        status: 'Connected',
        warnings: [
          {
            text: 'Keep-awake is off, so this machine may sleep and miss messages',
            fix: 'keepAwake'
          },
          { text: 'On battery, this machine is not being kept awake. Plug it in.' }
        ],
        hint: 'Keep the lid open: a closed lid sleeps regardless'
      })
    );
    const sheet = open(p);
    const warns = [...sheet.querySelectorAll<HTMLElement>('.bdlist .remote-warn')];
    assert.equal(warns.length, 2);
    const [off, battery] = warns;
    assert.ok(off && battery);
    assert.match(off.textContent ?? '', /may sleep and miss messages/);
    assert.equal(buttons(battery, 'Keep awake').length, 0);
    assert.equal(battery.querySelector('button'), null);
    const fix = buttons(off, 'Keep awake')[0];
    assert.ok(fix, 'no Keep awake on the may-sleep warning');
    fix.click();
    assert.deepEqual(p.posted, [{ type: 'setFlag', key: 'cafe', on: true }]);
    assert.equal(
      sheet.querySelector('.bdlist .remote-hint')?.textContent,
      'Keep the lid open: a closed lid sleeps regardless'
    );
  });

  it('counts the tokens set and the allowed accounts in their heads', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        setup: {
          fields: [
            { key: 'bot', label: 'Bot token', set: true },
            { key: 'app', label: 'App token', set: false }
          ],
          allowlist: ['T1:U1', 'T1:U2', 'T2:U3']
        }
      })
    );
    const detail = q(open(p), '.bddetail');
    assert.equal(
      section(detail, 'tokens').querySelector('.column-head .summary')?.textContent,
      '1 of 2 set'
    );
    assert.equal(
      section(detail, 'allowed').querySelector('.column-head .summary')?.textContent,
      '3'
    );
  });

  it('shuts from Escape, the backdrop and the close control, back on the Remote word', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const doc = p.window.document;
    const remote = word(p);
    remote.click();
    assert.equal(remote.getAttribute('aria-expanded'), 'true');
    escape(p);
    assert.ok($(p, '#bottomdrawer')?.hidden, 'Escape left Remote open');
    assert.equal(doc.activeElement, remote);
    assert.equal(remote.getAttribute('aria-expanded'), 'false');

    remote.click();
    $(p, '#bottomdrawer-scrim')?.click();
    assert.ok($(p, '#bottomdrawer')?.hidden, 'the backdrop left Remote open');
    assert.equal(doc.activeElement, remote);

    remote.click();
    $(p, '#bottomdrawer-close')?.click();
    assert.ok($(p, '#bottomdrawer')?.hidden, 'close left Remote open');
    assert.equal(doc.activeElement, remote);
  });

  it('repaints an open Remote in place on a push, keeping the focus', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ on: true, tone: 'pending', status: 'Connecting…' }));
    const sheet = open(p);
    const row = toggle(sheet);
    row.focus();
    push(p, remoteStateView({ on: true, tone: 'live', status: 'Connected' }));
    assert.equal(sheet.hidden, false);
    assert.equal(toggle(sheet), row, 'the focused switch was replaced');
    assert.equal(p.window.document.activeElement, row);
    assert.match(linkWord(sheet), /Connected/);
    assert.equal(dot(p).className, 'dot live');
  });
});

describe('Remote’s messengers', () => {
  it('lists one row per messenger, each with its mark', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ messengers: SLACKLIKE }));
    const rows = messengers(open(p));
    assert.deepEqual(rows.map(label), ['Slack', 'Discord', 'Telegram']);
    for (const row of rows)
      assert.ok(row.querySelector('.bmwrap svg'), `${label(row)} has no mark`);
  });

  it('draws no mark for a messenger it has none for', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const [row] = messengers(open(p));
    assert.ok(row);
    assert.equal(label(row), 'Chat');
    assert.equal(row.querySelector('.bmwrap'), null);
  });

  it('refuses a press on a messenger not built yet, and says why in its tip', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ messengers: SLACKLIKE }));
    const sheet = open(p);
    const discord = messengers(sheet).find((row) => label(row) === 'Discord');
    assert.ok(discord);
    assert.equal(discord.getAttribute('aria-disabled'), 'true');
    assert.equal(discord.dataset.tip, 'Not supported yet (D29).');
    discord.click();
    assert.deepEqual(p.posted, []);
    assert.ok(!discord.classList.contains('drilled'));
    assert.equal(sheet.querySelector('.bdlist .drilled .t')?.textContent, 'Slack');
  });

  it('marks the selected messenger, and the setup column is its', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        messengers: {
          rows: [
            { id: 'slack', label: 'Slack', live: true },
            { id: 'fake', label: 'Fake', live: true }
          ],
          selected: 'fake'
        },
        setup: { messenger: 'Fake' }
      })
    );
    const sheet = open(p);
    const drilled = [...sheet.querySelectorAll('.bdlist .messengers .drilled')];
    assert.deepEqual(drilled.map(label), ['Fake']);
    assert.equal(drilled[0]?.getAttribute('aria-current'), 'true');
    assert.equal(
      section(q(sheet, '.bddetail'), 'setup').querySelector('.column-title')?.textContent,
      'Fake setup'
    );
  });

  it('leads the column with Enable Remote, and pins the reason and warnings under the list', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const sheet = open(p);
    const keys = (): (string | undefined)[] =>
      [...q(sheet, '.bdlist').querySelectorAll<HTMLElement>(':scope > *')].map(
        (node) => node.dataset.key
      );
    assert.deepEqual(keys(), ['remote:switch', 'remote:messengers-title', 'remote:messengers']);
    assert.equal(label(toggle(sheet)), 'Enable Remote');
    assert.equal(sheet.querySelector('.bdlist .pinned'), null, 'a quiet sheet drew a footer');

    push(
      p,
      remoteStateView({
        messengers: SLACKLIKE,
        on: true,
        tone: 'fault',
        status: 'Not connected',
        reason: 'The bot token was refused.',
        warnings: [{ text: 'Keep-awake is off', fix: 'keepAwake' }]
      })
    );
    assert.deepEqual(keys(), [
      'remote:switch',
      'remote:messengers-title',
      'remote:messengers',
      'remote:pinned'
    ]);
    const pinned = q(sheet, '.bdlist .pinned');
    assert.equal(pinned.querySelector('[role="switch"]'), null);
    assert.equal(sheet.querySelector('.bdlist .messengers [role="switch"]'), null);
    assert.equal(label(toggle(sheet)), 'Enable Remote');
    assert.equal(pinned.querySelector('.remote-reason')?.textContent, 'The bot token was refused.');
    assert.equal(pinned.querySelectorAll('.remote-warn').length, 1);
  });
});

describe('Remote’s setup check', () => {
  it('shows actual optional incoming-file setup guidance through the existing guide protocol', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteView.remoteStateView(
        {
          state: { kind: 'off' },
          setup: { messenger: { id: 'slack', label: 'Slack' }, fields: [], allowlist: ['phone'] }
        },
        slackMessenger.slackEntry.setup
      )
    );
    const scrim = openGuide(p, open(p));
    const row = [...scrim.querySelectorAll('.asbody dt')].find(
      (node) => node.textContent === 'Incoming files'
    );
    assert.ok(row, 'the guide has no incoming-file migration row');
    const guidance = row.nextElementSibling?.textContent ?? '';
    assert.match(guidance, /files:read/);
    assert.match(guidance, /Messaging works without it/);
    assert.match(guidance, /reinstall/i);
  });

  it('keeps the setup verdict independent of Remote switching on and off', (t) => {
    const p = openPanel(t);
    const setup = {
      fields: [],
      sender: { help: '' },
      create: { steps: [{ title: 'Create the app', text: 'Create it.' }] }
    };
    const states: RemoteLink[] = [
      { kind: 'off' },
      { kind: 'connected', since: 1 },
      { kind: 'off' }
    ];
    const cases: { check?: CheckState; text: string; button: string }[] = [
      { text: 'Not checked', button: 'Check' },
      { check: { kind: 'never' }, text: 'Not checked', button: 'Check' },
      { check: { kind: 'checking' }, text: 'Checking…', button: 'Checking…' },
      {
        check: { kind: 'result', result: { kind: 'ok', facts: [] }, at: 5 },
        text: 'Configured',
        button: 'Check again'
      },
      {
        check: {
          kind: 'result',
          result: { kind: 'setup', step: 0, reason: 'Create the app first.' },
          at: 5
        },
        text: 'Create the app first.',
        button: 'Check again'
      }
    ];
    for (const one of cases) {
      for (const state of states) {
        push(
          p,
          remoteView.remoteStateView(
            {
              state,
              setup: { messenger: { id: 'chat', label: 'Chat' }, fields: [], allowlist: ['phone'] },
              ...(one.check ? { check: one.check } : {})
            },
            setup
          )
        );
        const right = section(q(open(p), '.bddetail'), 'setup');
        assert.match(q(right, '.verdict').textContent ?? '', new RegExp(one.text));
        assert.equal(buttons(right, one.button).length, 1);
      }
    }
  });

  const checked = (check: Partial<RemoteCheckView>): RemoteStateView =>
    remoteStateView({
      check: { verdict: 'never', text: 'Not checked', marks: ['todo', 'todo'], facts: [], ...check }
    });

  it('says a passing check in one row, with Check again, Guide and its facts in a tip', (t) => {
    const p = openPanel(t);
    push(
      p,
      checked({
        verdict: 'ok',
        text: 'Configured',
        marks: ['done', 'done'],
        facts: [
          { label: 'Workspace', value: 'Acme' },
          { label: 'Bot', value: '@squadron' }
        ]
      })
    );
    const setup = section(q(open(p), '.bddetail'), 'setup');
    const verdict = q(setup, '.verdict');
    assert.match(verdict.textContent ?? '', /Configured/);
    assert.equal(buttons(setup, 'Check again').length, 1);
    assert.equal(buttons(setup, 'Guide').length, 1);
    assert.equal(setup.querySelector('.checklist'), null, 'a passing check drew the steps');
    const facts = verdict.querySelector<HTMLElement>('[data-tip-rows]');
    assert.ok(facts, 'the facts are in no tip');
    assert.deepEqual(JSON.parse(facts.dataset.tipRows ?? '[]'), [
      ['Workspace', 'Acme', ''],
      ['Bot', '@squadron', '']
    ]);
  });

  it('says when a passing check ran, in its tip, as of each paint', (t) => {
    const p = openPanel(t);
    const facts = [{ label: 'Workspace', value: 'Acme' }];
    const minutes = (n: number) => Date.now() - n * 60_000 - 1_000;
    push(p, checked({ verdict: 'ok', text: 'Configured', facts, at: minutes(3) }));
    const setup = section(q(open(p), '.bddetail'), 'setup');
    const rows = () =>
      JSON.parse(q(setup, '.verdict [data-tip-rows]').dataset.tipRows ?? '[]') as string[][];
    assert.deepEqual(rows(), [
      ['Workspace', 'Acme', ''],
      ['Checked', '3m ago', '']
    ]);
    push(p, checked({ verdict: 'ok', text: 'Configured', facts, at: minutes(10) }));
    assert.deepEqual(rows().at(-1), ['Checked', '10m ago', '']);
  });

  it('draws a tip for a passing check with only its time to say', (t) => {
    const p = openPanel(t);
    push(p, checked({ verdict: 'ok', text: 'Configured', at: Date.now() - 5_000 }));
    const setup = section(q(open(p), '.bddetail'), 'setup');
    const tip = q(setup, '.verdict [data-tip-rows]');
    assert.deepEqual(JSON.parse(tip.dataset.tipRows ?? '[]'), [['Checked', '5s ago', '']]);
  });

  it('draws the steps under a failed check, each marked by what it found', (t) => {
    const p = openPanel(t);
    push(
      p,
      checked({ verdict: 'setup', text: 'The bot token was refused.', marks: ['done', 'failed'] })
    );
    const setup = section(q(open(p), '.bddetail'), 'setup');
    assert.match(q(setup, '.verdict').textContent ?? '', /The bot token was refused\./);
    const steps = [...setup.querySelectorAll<HTMLElement>('.checklist .gstep')];
    assert.deepEqual(
      steps.map((step) => step.querySelector('.stepname')?.textContent),
      ['Open it', 'Paste it']
    );
    assert.deepEqual(
      steps.map((step) => step.querySelector('.mk')?.className),
      ['mk st-done', 'mk st-failed']
    );
    assert.deepEqual(
      steps.map((step) => step.querySelector<HTMLElement>('.why')?.dataset.tip),
      ['Open the create page.', 'Paste the manifest.']
    );
  });

  it('numbers the steps to do before any check, beside Check', (t) => {
    const p = openPanel(t);
    push(p, checked({}));
    const setup = section(q(open(p), '.bddetail'), 'setup');
    assert.match(q(setup, '.verdict').textContent ?? '', /Not checked/);
    assert.equal(buttons(setup, 'Check').length, 1);
    assert.deepEqual(
      [...setup.querySelectorAll('.checklist .mk')].map((mark) => mark.textContent),
      ['1', '2']
    );
  });

  it('says an unreachable messenger, and blames no step', (t) => {
    const p = openPanel(t);
    push(p, checked({ verdict: 'unreachable', text: 'Chat could not be reached.' }));
    const setup = section(q(open(p), '.bddetail'), 'setup');
    assert.match(q(setup, '.verdict').textContent ?? '', /Chat could not be reached\./);
    assert.equal(setup.querySelector('.st-failed'), null);
    assert.equal(setup.querySelector('.st-done'), null);
  });

  it('posts one checkRemote for Check, and a check in flight takes no second press', (t) => {
    const p = openPanel(t);
    push(p, checked({}));
    const sheet = open(p);
    press(section(q(sheet, '.bddetail'), 'setup'), 'Check');
    press(section(q(sheet, '.bddetail'), 'setup'), 'Checking…');
    assert.deepEqual(p.posted, [{ type: 'checkRemote' }]);

    push(p, checked({ verdict: 'checking', text: 'Checking…' }));
    const busy = buttons(section(q(sheet, '.bddetail'), 'setup'), 'Checking…')[0];
    assert.ok(busy, 'a check in flight drew a press');
    assert.equal(busy.getAttribute('aria-disabled'), 'true');
    busy.click();
    assert.deepEqual(p.posted, [{ type: 'checkRemote' }]);

    push(p, checked({ verdict: 'ok', text: 'Configured', marks: ['done', 'done'] }));
    press(section(q(sheet, '.bddetail'), 'setup'), 'Check again');
    assert.deepEqual(p.posted, [{ type: 'checkRemote' }, { type: 'checkRemote' }]);
  });

  it('holds Check through a reply that is not a state push', (t) => {
    const p = openPanel(t);
    push(p, checked({}));
    const sheet = open(p);
    press(section(q(sheet, '.bddetail'), 'setup'), 'Check');
    p.push({ type: 'remoteChoice', on: false, landed: true });
    p.push({ type: 'remoteAllowlistFailed', reason: 'The allowed accounts were not saved.' });
    const held = buttons(section(q(sheet, '.bddetail'), 'setup'), 'Checking…')[0];
    assert.ok(held, 'a reply freed Check before the host said it was checking');
    assert.equal(held.getAttribute('aria-disabled'), 'true');
    held.click();
    assert.deepEqual(p.posted, [{ type: 'checkRemote' }]);
  });
});

describe('Remote’s guide', () => {
  const withExisting = (): RemoteStateView =>
    remoteStateView({
      setup: {
        create: {
          steps: [
            { title: 'Open it', text: 'Open the create page.' },
            { title: 'Paste it', text: 'Paste the manifest.' }
          ],
          existing: [
            { label: 'Socket Mode', value: 'on' },
            { label: 'Bot events', value: 'message.im' }
          ],
          copyLabel: 'Copy manifest',
          link: true
        }
      }
    });

  it('opens a centred sheet with every step’s text and the existing-app rows', (t) => {
    const p = openPanel(t);
    push(p, withExisting());
    const guideSheet = openGuide(p, open(p));
    assert.equal(guideSheet.querySelector('.ashead b')?.textContent, 'Set up Chat');
    assert.deepEqual(
      [...guideSheet.querySelectorAll('.asbody ol li')].map((li) => li.textContent),
      ['Open the create page.', 'Paste the manifest.']
    );
    assert.deepEqual(
      [...guideSheet.querySelectorAll('.asbody dt')].map((dt) => [
        dt.textContent,
        dt.nextElementSibling?.textContent
      ]),
      [
        ['Socket Mode', 'on'],
        ['Bot events', 'message.im']
      ]
    );
  });

  it('is a dialog, named by its title', (t) => {
    const p = openPanel(t);
    push(p, withExisting());
    const guideSheet = openGuide(p, open(p));
    assert.equal(guideSheet.getAttribute('role'), 'dialog');
    const name = p.window.document.getElementById(guideSheet.getAttribute('aria-labelledby') ?? '');
    assert.equal(name?.textContent, 'Set up Chat');
  });

  it('takes the focus in, and gives it back to Guide when it shuts', (t) => {
    const p = openPanel(t);
    push(p, withExisting());
    const sheet = open(p);
    openGuide(p, sheet);
    const doc = p.window.document;
    assert.ok(guide(p)?.contains(doc.activeElement), 'the focus stayed behind the guide');
    $(p, '#gscrim .ax')?.click();
    assert.equal(doc.activeElement, buttons(section(q(sheet, '.bddetail'), 'setup'), 'Guide')[0]);
  });

  it('copies the manifest and opens the create page on the host, leaving the drawer open', (t) => {
    const p = openPanel(t);
    push(p, withExisting());
    const sheet = open(p);
    const guideSheet = openGuide(p, sheet);
    press(guideSheet, 'Copy manifest');
    assert.deepEqual(p.posted, [{ type: 'copyRemoteSetup' }]);
    assert.equal(buttons(guideSheet, 'Copied').length, 1, 'the copy did not say so');
    press(guideSheet, 'Open the create page');
    assert.deepEqual(p.posted.at(-1), { type: 'openRemoteSetupLink' });
    assert.equal(sheet.hidden, false, 'a press in the guide shut the drawer');
    assert.equal(guide(p)?.hidden, false);
  });

  it('offers no create page when there is no link', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        setup: {
          create: {
            steps: [{ title: 'Make', text: 'Make it.' }],
            copyLabel: 'Copy manifest',
            link: false
          }
        }
      })
    );
    const guideSheet = openGuide(p, open(p));
    assert.equal(buttons(guideSheet, 'Open the create page').length, 0);
    assert.equal(buttons(guideSheet, 'Copy manifest').length, 1);
  });

  it('shuts from X and the backdrop, and a click inside it, none of them shutting the drawer', (t) => {
    const p = openPanel(t);
    push(p, withExisting());
    const sheet = open(p);
    q(openGuide(p, sheet), '.asbody').click();
    assert.equal(guide(p)?.hidden, false, 'a click inside shut the guide');
    assert.equal(sheet.hidden, false, 'a click inside the guide shut the drawer');
    $(p, '#gscrim .ax')?.click();
    assert.equal(guide(p)?.hidden, true);
    assert.equal(sheet.hidden, false, 'X shut the drawer');
    openGuide(p, sheet);
    guide(p)?.click();
    assert.equal(guide(p)?.hidden, true);
    assert.equal(sheet.hidden, false, 'the backdrop shut the drawer');
  });

  it('takes the first Escape, and the drawer the second', (t) => {
    const p = openPanel(t);
    push(p, withExisting());
    const sheet = open(p);
    openGuide(p, sheet);
    escape(p);
    assert.equal(guide(p)?.hidden, true, 'Escape left the guide');
    assert.equal(sheet.hidden, false, 'Escape shut the drawer under the guide');
    escape(p);
    assert.equal(sheet.hidden, true);
  });
});

describe('Remote’s guide across a change of messenger', () => {
  const OTHER: Omit<RemoteStateView['messengers'], 'state'> = {
    rows: [
      { id: 'chat', label: 'Chat', live: true },
      { id: 'other', label: 'Other', live: true }
    ],
    selected: 'other'
  };
  const other = (): RemoteStateView =>
    remoteStateView({ messengers: OTHER, setup: { messenger: 'Other' } });
  const guideButton = (sheet: HTMLElement): HTMLElement | undefined =>
    buttons(section(q(sheet, '.bddetail'), 'setup'), 'Guide')[0];

  it('stays open across a push for the same messenger', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    openGuide(p, open(p));
    push(p, remoteStateView({ status: 'Connecting' }));
    assert.equal(guide(p)?.hidden, false);
  });

  it('shuts when a push selects another messenger, and gives the focus back to Guide', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const sheet = open(p);
    openGuide(p, sheet);
    push(p, other());
    assert.equal(guide(p)?.hidden, true, 'the guide stayed up for the messenger it was not for');
    assert.equal(sheet.hidden, false, 'the change shut the drawer');
    assert.equal(p.window.document.activeElement, guideButton(sheet));
    openGuide(p, sheet);
    assert.equal(q(guide(p) as HTMLElement, '.ashead b').textContent, 'Set up Other');
  });

  it('gives the focus to the drawer when the new messenger has no guide', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const sheet = open(p);
    openGuide(p, sheet);
    const bare = other();
    delete bare.setup.create;
    push(p, bare);
    assert.equal(guide(p)?.hidden, true);
    assert.equal(guideButton(sheet), undefined);
    assert.equal(p.window.document.activeElement, $(p, '#bottomdrawer-close'));
  });

  it('shuts when the host stops sending Remote', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const sheet = open(p);
    openGuide(p, sheet);
    push(p);
    assert.equal(guide(p)?.hidden, true);
    assert.equal(sheet.hidden, false);
    assert.equal(p.window.document.activeElement, $(p, '#bottomdrawer-close'));
  });
});

describe('Remote’s tokens and allowed accounts', () => {
  const page = (p: Panel): HTMLElement => q(open(p), '.bddetail');
  const idField = (detail: HTMLElement): HTMLInputElement => {
    const field = detail.querySelector<HTMLInputElement>('.remote-allow input');
    assert.ok(field, 'no field to add an allowed account');
    return field;
  };
  const type = (p: Panel, field: HTMLInputElement, text: string): void => {
    field.value = text;
    field.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  };
  const why = (sect: HTMLElement): string =>
    sect.querySelector<HTMLElement>('.column-head .why')?.dataset.tip ?? '';

  it('says whether each token is set, and asks the host for one', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        setup: {
          fields: [
            { key: 'bot', label: 'Bot token', set: true },
            { key: 'app', label: 'App token', set: false }
          ]
        }
      })
    );
    const tokens = section(page(p), 'tokens');
    const rows = [...tokens.querySelectorAll<HTMLElement>('.remote-field')];
    assert.deepEqual(
      rows.map((row) => [
        row.querySelector('.k')?.textContent,
        row.querySelector('.v')?.textContent
      ]),
      [
        ['Bot token', 'Set'],
        ['App token', 'Not set']
      ]
    );
    const [bot, app] = rows;
    assert.ok(bot && app);
    assert.equal(buttons(bot, 'Replace…').length, 1);
    press(app, 'Paste…');
    assert.deepEqual(p.posted, [{ type: 'setRemoteField', key: 'app' }]);
    press(bot, 'Replace…');
    assert.deepEqual(p.posted.at(-1), { type: 'setRemoteField', key: 'bot' });
    assert.match(why(tokens), /Kept in the OS keychain, never in settings files/);
  });

  it('says where a token comes from in its tip, when the messenger says', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        setup: {
          fields: [
            { key: 'bot', label: 'Bot token', set: true, help: 'From the install page.' },
            { key: 'app', label: 'App token', set: false }
          ]
        }
      })
    );
    const [bot, app] = [...section(page(p), 'tokens').querySelectorAll('.remote-field')];
    assert.equal(bot?.querySelector<HTMLElement>('.why')?.dataset.tip, 'From the install page.');
    assert.equal(app?.querySelector('.why'), null);
  });

  it('asks before removing the tokens, and only the confirm posts', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const detail = page(p);
    press(detail, 'Remove tokens');
    assert.deepEqual(p.posted, []);
    press(detail, 'Cancel');
    assert.deepEqual(p.posted, []);
    assert.equal(buttons(detail, 'Remove tokens').length, 1, 'Cancel did not put the button back');
    press(detail, 'Remove tokens');
    press(detail, 'Remove');
    assert.deepEqual(p.posted, [{ type: 'forgetRemote' }]);
  });

  it('asks on the row a repaint kept, and its Remove still posts', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const detail = page(p);
    press(detail, 'Remove tokens');
    push(p, remoteStateView({ status: 'Off.' }));
    press(detail, 'Cancel');
    assert.equal(buttons(detail, 'Remove tokens').length, 1, 'Cancel after a repaint was lost');
    press(detail, 'Remove tokens');
    push(p, remoteStateView({ status: 'Off' }));
    press(detail, 'Remove');
    assert.deepEqual(p.posted, [{ type: 'forgetRemote' }]);
  });

  it('adds a trimmed id to the end of the whole list', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { allowlist: ['T1:U1'] } }));
    const detail = page(p);
    type(p, idField(detail), '  T2:U2 ');
    press(detail, 'Add');
    assert.deepEqual(p.posted, [{ type: 'setRemoteAllowlist', ids: ['T1:U1', 'T2:U2'] }]);
    assert.equal(idField(detail).value, '', 'the field kept an id it posted');

    type(p, idField(detail), 'T3:U3');
    idField(detail).dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    assert.deepEqual(
      p.posted.at(-1),
      { type: 'setRemoteAllowlist', ids: ['T1:U1', 'T2:U2', 'T3:U3'] },
      'a second add before the echo dropped the first'
    );
  });

  it('posts nothing for a blank id or one already listed', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { allowlist: ['T1:U1'] } }));
    const detail = page(p);
    type(p, idField(detail), '   ');
    press(detail, 'Add');
    type(p, idField(detail), ' T1:U1 ');
    press(detail, 'Add');
    assert.deepEqual(p.posted, []);
  });

  it('removes an id by posting the list without it', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { allowlist: ['T1:U1', 'T2:U2'] } }));
    const detail = page(p);
    const listed = [...detail.querySelectorAll<HTMLElement>('.remote-id')];
    assert.deepEqual(
      listed.map((row) => row.querySelector('.k')?.textContent),
      ['T1:U1', 'T2:U2']
    );
    const remove = listed[0]?.querySelector<HTMLElement>('button');
    assert.equal(remove?.getAttribute('aria-label'), 'Remove T1:U1');
    remove?.click();
    assert.deepEqual(p.posted, [{ type: 'setRemoteAllowlist', ids: ['T2:U2'] }]);
  });

  it('removes two ids pressed before the echo, each on top of the last', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { allowlist: ['T1:U1', 'T2:U2'] } }));
    const detail = page(p);
    detail.querySelector<HTMLElement>('[aria-label="Remove T1:U1"]')?.click();
    detail.querySelector<HTMLElement>('[aria-label="Remove T2:U2"]')?.click();
    assert.deepEqual(p.posted, [
      { type: 'setRemoteAllowlist', ids: ['T2:U2'] },
      { type: 'setRemoteAllowlist', ids: [] }
    ]);
  });

  it('edits the pushed list again once a push agrees with the last edit', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { allowlist: ['T1:U1', 'T2:U2'] } }));
    const detail = page(p);
    detail.querySelector<HTMLElement>('[aria-label="Remove T1:U1"]')?.click();
    push(p, remoteStateView({ setup: { allowlist: ['T2:U2'] } }));
    // Settings edited elsewhere after the echo: the sheet follows the push now.
    push(p, remoteStateView({ setup: { allowlist: ['T2:U2', 'T4:U4'] } }));
    detail.querySelector<HTMLElement>('[aria-label="Remove T2:U2"]')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'setRemoteAllowlist', ids: ['T4:U4'] });
  });

  it('drops the edit in flight once a push changes the list some other way', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { allowlist: ['T1:U1', 'T2:U2', 'T3:U3'] } }));
    const detail = page(p);
    detail.querySelector<HTMLElement>('[aria-label="Remove T3:U3"]')?.click();
    // Another window removed T2 before this edit's echo, and that write won.
    push(p, remoteStateView({ setup: { allowlist: ['T1:U1', 'T3:U3'] } }));
    type(p, idField(detail), 'T4:U4');
    press(detail, 'Add');
    assert.deepEqual(p.posted.at(-1), {
      type: 'setRemoteAllowlist',
      ids: ['T1:U1', 'T3:U3', 'T4:U4']
    });
  });

  it('keeps the newer edit in flight when a push echoes an older one', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { allowlist: ['T1:U1', 'T2:U2'] } }));
    const detail = page(p);
    detail.querySelector<HTMLElement>('[aria-label="Remove T1:U1"]')?.click();
    detail.querySelector<HTMLElement>('[aria-label="Remove T2:U2"]')?.click();
    // The first removal's echo, while the second is still in flight.
    push(p, remoteStateView({ setup: { allowlist: ['T2:U2'] } }));
    type(p, idField(detail), 'T3:U3');
    press(detail, 'Add');
    assert.deepEqual(p.posted.at(-1), { type: 'setRemoteAllowlist', ids: ['T3:U3'] });
  });

  it('says a save that failed, and composes the next edit on the pushed list', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { allowlist: ['T1:U1', 'T2:U2', 'T3:U3'] } }));
    const detail = page(p);
    detail.querySelector<HTMLElement>('[aria-label="Remove T1:U1"]')?.click();
    p.push({
      type: 'remoteAllowlistFailed',
      reason: 'The allowed accounts were not saved: settings.json has errors.'
    });
    assert.equal(
      detail.querySelector('.remote-failed')?.textContent,
      'The allowed accounts were not saved: settings.json has errors.'
    );
    detail.querySelector<HTMLElement>('[aria-label="Remove T3:U3"]')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'setRemoteAllowlist', ids: ['T1:U1', 'T2:U2'] });
    assert.equal(detail.querySelector('.remote-failed'), null, 'the next edit clears the reason');
  });

  it('keeps a half-typed id, its caret, its focus and Add across a repaint', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { allowlist: [] } }));
    const detail = page(p);
    const before = idField(detail);
    before.focus();
    type(p, before, 'T9:U');
    before.setSelectionRange(2, 2);
    push(
      p,
      remoteStateView({
        setup: { allowlist: [], fields: [{ key: 'bot', label: 'Bot token', set: false }] }
      })
    );
    assert.equal(
      detail.querySelector('.remote-field .v')?.textContent,
      'Not set',
      'the push did not repaint the sheet'
    );
    const after = idField(detail);
    assert.equal(after.value, 'T9:U');
    assert.equal(p.window.document.activeElement, after);
    assert.equal(after.selectionStart, 2);
    assert.equal(after.selectionEnd, 2);
    type(p, after, 'T9:U9');
    press(detail, 'Add');
    assert.deepEqual(p.posted, [{ type: 'setRemoteAllowlist', ids: ['T9:U9'] }]);
  });

  it('types no secret into this document', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        setup: {
          fields: [
            { key: 'bot', label: 'Bot token', set: true },
            { key: 'app', label: 'App token', set: false }
          ]
        }
      })
    );
    const sheet = open(p);
    const detail = q(sheet, '.bddetail');
    assert.ok(detail.querySelector('input'), 'the sheet has no field at all');
    assert.equal(p.window.document.querySelector('input[type="password"]'), null);
    assert.equal(idField(detail).type, 'text');
    assert.equal(idField(detail).placeholder, 'T…:U…');
    const allowed = section(detail, 'allowed');
    assert.match(why(allowed), /Your member id, from your profile\./);
    assert.match(why(allowed), /Messages from anyone else are ignored, with no reply/);
    // A token reaches the host's own password box, never a control here: the
    // right column's one editable control is the account to allow.
    const editable = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
    assert.deepEqual([...detail.querySelectorAll(editable)], [idField(detail)]);
    const tokens = section(detail, 'tokens');
    assert.equal(tokens.querySelector(editable), null, 'the Tokens section takes typing');
    assert.equal(buttons(tokens, 'Paste…').length, 1);
    assert.equal(buttons(tokens, 'Replace…').length, 1);
    assert.equal(openGuide(p, sheet).querySelector(editable), null, 'the guide takes typing');
  });

  it('draws no setup when the host sends no Remote', (t) => {
    const p = openPanel(t);
    push(p);
    const detail = page(p);
    assert.equal(detail.querySelector('input, .remote-field, .sect'), null);
  });
});

describe('Remote’s space and the accounts it cannot use', () => {
  const page = (p: Panel): HTMLElement => q(open(p), '.bddetail');
  const SPACE = { label: 'Workspace', help: 'Check fills it in.', placeholder: 'T0123ABCD' };
  const spaceRow = (detail: HTMLElement): HTMLElement =>
    q(section(detail, 'allowed'), '.remote-space');

  it('draws the space at the head of Allowed accounts, Not set, and Set… asks the host', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { space: SPACE } }));
    const row = spaceRow(page(p));
    assert.equal(row.querySelector('.k')?.textContent, 'Workspace');
    assert.equal(row.querySelector<HTMLElement>('.why')?.dataset.tip, 'Check fills it in.');
    assert.equal(row.querySelector('.v')?.textContent, 'Not set');
    press(row, 'Set…');
    assert.deepEqual(p.posted, [{ type: 'setRemoteSpace' }]);
  });

  it('shows the space set, and Change… asks the host', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { space: { ...SPACE, value: 'T0SQUAD01' } } }));
    const row = spaceRow(page(p));
    assert.equal(row.querySelector('.v.set')?.textContent, 'T0SQUAD01');
    press(row, 'Change…');
    assert.deepEqual(p.posted, [{ type: 'setRemoteSpace' }]);
  });

  it('offers a different space the check found, and Use sets it', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({ setup: { space: { ...SPACE, value: 'T0SQUAD01', found: 'T0OTHER01' } } })
    );
    const found = q(section(page(p), 'allowed'), '.remote-found');
    assert.match(found.textContent ?? '', /The tokens are for T0OTHER01\./);
    const use = q(found, 'button');
    assert.equal(use.getAttribute('aria-label'), 'Use T0OTHER01');
    use.click();
    assert.deepEqual(p.posted, [{ type: 'setRemoteSpace', value: 'T0OTHER01' }]);
  });

  it('says why a stored space cannot be used', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        setup: { space: { ...SPACE, value: 'squad', problem: 'A workspace id starts with T.' } }
      })
    );
    const allowed = section(page(p), 'allowed');
    assert.equal(
      allowed.querySelector('.remote-space + .remote-problem')?.textContent,
      'A workspace id starts with T.'
    );
  });

  it('marks each account it cannot use, with why under it', (t) => {
    const p = openPanel(t);
    push(
      p,
      remoteStateView({
        setup: {
          space: SPACE,
          allowlist: ['U1', 'T1:U2'],
          unusable: [{ account: 'U1', reason: 'Waiting on the Workspace: press Check, or set it.' }]
        }
      })
    );
    const rows = [...section(page(p), 'allowed').querySelectorAll<HTMLElement>('.remote-id')];
    assert.deepEqual(
      rows.map((row) => [row.querySelector('.k')?.textContent, row.classList.contains('bad')]),
      [
        ['U1', true],
        ['T1:U2', false]
      ]
    );
    const problem = rows[0]?.nextElementSibling;
    assert.ok(problem?.classList.contains('remote-problem'));
    assert.equal(problem?.textContent, 'Waiting on the Workspace: press Check, or set it.');
    assert.equal(rows[1]?.nextElementSibling?.classList.contains('remote-problem'), false);
  });

  it('gives a refused account back to the field, with the reason', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { allowlist: ['T1:U1'] } }));
    const detail = page(p);
    const field = q(detail, '.remote-allow input') as HTMLInputElement;
    field.value = 'bob@x';
    field.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    press(detail, 'Add');
    assert.equal(field.value, '');
    p.push({
      type: 'remoteAllowlistFailed',
      reason: 'bob@x was not added. A member id starts with U.',
      account: 'bob@x'
    });
    assert.equal(
      detail.querySelector('.remote-failed')?.textContent,
      'bob@x was not added. A member id starts with U.'
    );
    assert.equal((q(detail, '.remote-allow input') as HTMLInputElement).value, 'bob@x');
  });

  it('gives a refused account back only to an empty field, never over a correction', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ setup: { allowlist: ['T1:U1'] } }));
    const detail = page(p);
    const field = q(detail, '.remote-allow input') as HTMLInputElement;
    field.value = 'bob@x';
    field.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    press(detail, 'Add');
    field.value = 'U2';
    field.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    p.push({
      type: 'remoteAllowlistFailed',
      reason: 'bob@x was not added. A member id starts with U.',
      account: 'bob@x'
    });
    assert.equal((q(detail, '.remote-allow input') as HTMLInputElement).value, 'U2');
  });

  it('draws no space row for a messenger with none', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    assert.equal(section(page(p), 'allowed').querySelector('.remote-space'), null);
  });
});

describe('Remote’s sheet, the rest of it', () => {
  it('holds a labelled, empty Interactions slot', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView());
    const slot = section(q(open(p), '.bddetail'), 'interactions');
    assert.equal(slot.querySelector('.column-title')?.textContent, 'Interactions');
    assert.ok(slot.querySelector('.slot')?.textContent);
    assert.equal(slot.querySelector('button, input'), null);
  });

  it('offers no Set up, and settings has no Remote', (t) => {
    const p = openPanel(t);
    push(p, remoteStateView({ missing: ['Bot token'], tone: 'fault', on: true }));
    const sheet = open(p);
    assert.equal(buttons(sheet, 'Set up').length, 0);
    $(p, '#bottomdrawer-close')?.click();
    $(p, '#nav .gear')?.click();
    const dialog = p.window.document.querySelector<HTMLDialogElement>('#settings');
    assert.ok(dialog?.open);
    const tabs = [...dialog.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    assert.ok(!tabs.includes('Remote'), 'settings still has a Remote category');
    assert.equal(dialog.querySelector('#settings-remote'), null);
  });
});

function q(root: Element, sel: string): HTMLElement {
  const node = root.querySelector<HTMLElement>(sel);
  assert.ok(node, `no ${sel}`);
  return node;
}
