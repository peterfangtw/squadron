import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  groupView,
  openPanel,
  openSettings,
  openThread,
  stateMessage,
  switchedOn,
  threadView,
  type Panel
} from '../harness';

const missing = (brand: 'claude' | 'codex' | 'grok', name: string): AccountView => ({
  brand,
  name,
  mark: brand,
  state: 'not_installed',
  label: 'Not installed',
  detail: name
});

const nothingInstalled = (): AccountView[] => [
  missing('claude', 'Claude'),
  missing('codex', 'Codex'),
  missing('grok', 'Grok')
];

const claudeReady = (): AccountView[] => [
  {
    brand: 'claude',
    name: 'Claude',
    mark: 'claude',
    state: 'signed_in',
    label: 'you@example.com',
    detail: 'Claude'
  },
  {
    brand: 'codex',
    name: 'Codex',
    mark: 'codex',
    state: 'signed_out',
    label: 'Not signed in',
    detail: 'Codex'
  },
  missing('grok', 'Grok')
];

const dialog = (p: Panel): HTMLDialogElement => {
  const d = p.window.document.querySelector<HTMLDialogElement>('#onboarding');
  assert.ok(d, 'no #onboarding dialog');
  return d;
};

const button = (p: Panel, id: string): HTMLButtonElement => {
  const b = p.window.document.querySelector<HTMLButtonElement>(`#${id}`);
  assert.ok(b, `no #${id}`);
  return b;
};

const stepLabel = (p: Panel): string =>
  dialog(p).querySelector('.obstep')?.textContent?.trim() ?? '';

const open = (p: Panel, accounts: AccountView[]): void =>
  p.push(stateMessage([groupView()], { accounts, onboarding: true }));

describe('onboarding — setup', () => {
  it('opens at setup with one account row per brand', (t) => {
    const p = openPanel(t);
    assert.equal(dialog(p).open, false);
    open(p, nothingInstalled());
    assert.equal(dialog(p).open, true);
    assert.equal(stepLabel(p), 'Setup');
    assert.equal(dialog(p).querySelectorAll('.acct').length, 3);
  });

  it('holds Continue and Escape until the box is ticked when nothing is installed', (t) => {
    const p = openPanel(t);
    open(p, nothingInstalled());
    const proceed = button(p, 'onboarding-continue');
    assert.equal(proceed.disabled, true);
    const cancel = new p.window.Event('cancel', { cancelable: true });
    dialog(p).dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true);
    assert.equal(dialog(p).open, true);

    button(p, 'onboarding-ack').click();
    assert.equal(proceed.disabled, false);
    proceed.click();
    assert.equal(stepLabel(p), '1 of 3');
    assert.deepEqual(p.posted, []);
  });

  it('lets Continue through with no box once a CLI is installed', (t) => {
    const p = openPanel(t);
    open(p, claudeReady());
    assert.equal(p.window.document.querySelector('#onboarding-ack'), null);
    button(p, 'onboarding-continue').click();
    assert.equal(stepLabel(p), '1 of 3');
  });

  it('repaints the rows and frees Continue when a CLI turns up mid-setup', (t) => {
    const p = openPanel(t);
    open(p, nothingInstalled());
    assert.equal(button(p, 'onboarding-continue').disabled, true);
    open(p, claudeReady());
    assert.equal(dialog(p).open, true);
    assert.equal(stepLabel(p), 'Setup');
    assert.match(dialog(p).textContent ?? '', /you@example\.com/);
    assert.equal(button(p, 'onboarding-continue').disabled, false);
  });

  it('asks the host to look again, and sends Install where the popover does', (t) => {
    const p = openPanel(t);
    open(p, nothingInstalled());
    button(p, 'onboarding-recheck').click();
    const install = [...dialog(p).querySelectorAll<HTMLButtonElement>('.acct .act')].find(
      (b) => b.textContent === 'Install'
    );
    assert.ok(install);
    install.click();
    assert.deepEqual(p.posted, [{ type: 'recheckClis' }, { type: 'installCli', brand: 'claude' }]);
  });

  it('steps aside for Sign in and comes back when the login sheet closes', (t) => {
    const p = openPanel(t);
    open(p, claudeReady());
    const signIn = [...dialog(p).querySelectorAll<HTMLButtonElement>('.acct .act')].find(
      (b) => b.textContent === 'Sign in'
    );
    assert.ok(signIn);
    signIn.click();
    assert.equal(dialog(p).open, false);
    assert.deepEqual(p.posted, [{ type: 'startLogin', brand: 'codex' }]);

    open(p, claudeReady());
    assert.equal(dialog(p).open, false, 'reopened over the login sheet');

    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    const cancel = [...(scrim?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (b) => b.textContent === 'Cancel'
    );
    assert.ok(cancel);
    cancel.click();
    open(p, claudeReady());
    assert.equal(dialog(p).open, true);
    assert.equal(stepLabel(p), 'Setup');
    assert.ok(!p.posted.some((m) => m.type === 'onboardingDone'));
  });
});

describe('onboarding — tour', () => {
  const tour = (p: Panel): void => {
    open(p, claudeReady());
    button(p, 'onboarding-continue').click();
  };

  it('walks forward and back, with the dots following', (t) => {
    const p = openPanel(t);
    tour(p);
    const lit = (): number =>
      [...dialog(p).querySelectorAll('.obdots i')].findIndex((i) => i.classList.contains('on'));
    assert.equal(lit(), 0);
    button(p, 'onboarding-next').click();
    assert.equal(stepLabel(p), '2 of 3');
    assert.equal(lit(), 1);
    button(p, 'onboarding-back').click();
    assert.equal(stepLabel(p), '1 of 3');
    button(p, 'onboarding-back').click();
    assert.equal(stepLabel(p), 'Setup');
  });

  it('finishes once on Done and stays shut after', (t) => {
    const p = openPanel(t);
    tour(p);
    button(p, 'onboarding-next').click();
    button(p, 'onboarding-next').click();
    assert.equal(stepLabel(p), '3 of 3');
    assert.doesNotMatch(dialog(p).textContent ?? '', /drag|hand.?off/i);
    assert.match(dialog(p).textContent ?? '', /filter/i);
    assert.match(dialog(p).textContent ?? '', /identifier.*Linear/i);
    assert.equal(p.window.document.querySelector('#onboarding-skip'), null);
    button(p, 'onboarding-next').click();
    assert.equal(dialog(p).open, false);
    assert.deepEqual(p.posted, [{ type: 'onboardingDone' }]);
    open(p, claudeReady());
    assert.equal(dialog(p).open, false);
  });

  it('finishes on Skip', (t) => {
    const p = openPanel(t);
    tour(p);
    button(p, 'onboarding-skip').click();
    assert.equal(dialog(p).open, false);
    assert.deepEqual(p.posted, [{ type: 'onboardingDone' }]);
  });

  it('keeps its Escape from a session busy behind it', (t) => {
    // The native cancel is the keydown's default action, so it comes after the
    // window has heard the key — the dialog has to take it on the keydown.
    const p = openThread(t, threadView({ pid: 7, status: 'busy' }), {
      accounts: claudeReady(),
      onboarding: true
    });
    button(p, 'onboarding-continue').click();
    assert.equal(dialog(p).open, true, 'onboarding did not open');
    dialog(p).dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.equal(dialog(p).open, false);
    assert.equal(p.posted.filter((m) => m.type === 'interrupt').length, 0);
  });

  it('finishes on Escape', (t) => {
    const p = openPanel(t);
    tour(p);
    dialog(p).dispatchEvent(new p.window.Event('cancel', { cancelable: true }));
    assert.equal(dialog(p).open, false);
    assert.deepEqual(p.posted, [{ type: 'onboardingDone' }]);
  });

  it('offers the Orchestration switch the Agents drawer offers', (t) => {
    const p = openPanel(t);
    tour(p);
    button(p, 'onboarding-next').click();
    const row = dialog(p).querySelector<HTMLElement>('.mrow');
    assert.ok(row);
    assert.equal(row.getAttribute('role'), 'switch');
    assert.equal(row.querySelector('.t')?.textContent, 'Orchestration');
    assert.equal(switchedOn(row), false);
    row.click();
    assert.deepEqual(p.posted, [{ type: 'setFlag', key: 'orchestrators', on: true }]);
  });

  const skill = (p: Panel): HTMLElement | null =>
    dialog(p).querySelector<HTMLElement>('#onboarding-skill');
  const marks = (p: Panel): string[] =>
    [...(skill(p)?.querySelectorAll('.sk') ?? [])].map(
      (m) => `${m.className} ${m.getAttribute('role')} ${m.getAttribute('aria-label')}`
    );
  const detail = (p: Panel): string => skill(p)?.querySelector('.d')?.textContent ?? '';

  it("marks which CLIs have the skill, in the switch's box", (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: claudeReady(),
        onboarding: true,
        skillInstall: [
          { name: 'Claude', state: 'installed' },
          { name: 'Codex', state: 'foreign' }
        ]
      })
    );
    button(p, 'onboarding-continue').click();
    button(p, 'onboarding-next').click();
    assert.equal(skill(p)?.parentElement?.className, 'oblist');
    assert.deepEqual(marks(p), [
      'sk installed img Claude: installed',
      'sk foreign img Codex: Squadron leaves this path alone'
    ]);
    assert.equal(detail(p), 'Squadron leaves the path for Codex alone.');
  });

  it('points a missing skill at the switch, whichever way it is set', (t) => {
    const p = openPanel(t);
    const push = (orchestrators: boolean): void =>
      p.push(
        stateMessage([groupView()], {
          accounts: claudeReady(),
          onboarding: true,
          orchestrators,
          skillInstall: [{ name: 'Claude', state: 'missing' }]
        })
      );
    push(false);
    button(p, 'onboarding-continue').click();
    button(p, 'onboarding-next').click();
    assert.deepEqual(marks(p), ['sk missing img Claude: not installed']);
    assert.equal(detail(p), 'Turning Orchestration on installs it.');
    push(true);
    assert.equal(detail(p), 'Switch Orchestration off and on to install it.');
  });

  it('says nothing about the skill when no CLI has a directory for it', (t) => {
    const p = openPanel(t);
    tour(p);
    button(p, 'onboarding-next').click();
    assert.equal(skill(p), null);
  });
});

describe('onboarding — from the gear', () => {
  it('opens at setup even once finished', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { accounts: claudeReady(), onboarding: false }));
    const menu = openSettings(p, 'About');
    const again = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Show onboarding'
    );
    assert.ok(again, 'no Show onboarding in the settings menu');
    again.click();
    assert.equal(dialog(p).open, true);
    assert.equal(stepLabel(p), 'Setup');
    assert.deepEqual(p.posted, []);
  });
});
