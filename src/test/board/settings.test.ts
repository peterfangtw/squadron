import * as assert from 'node:assert/strict';
import * as test from 'node:test';
import * as harness from '../harness';

function modal(p: harness.Panel): HTMLDialogElement {
  p.window.document.querySelector<HTMLElement>('#nav .gear')?.click();
  const dialog = p.window.document.querySelector<HTMLDialogElement>('#settings');
  assert.ok(dialog?.open, 'the gear opens the settings dialog');
  return dialog;
}

function tab(dialog: HTMLElement, name: string): void {
  const button = [...dialog.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (item) => item.textContent === name
  );
  assert.ok(button, `missing ${name} tab`);
  button.click();
}

test.describe('settings modal', () => {
  test.it(
    'nudges the gear, Report and Survey until Survey is clicked, then remembers the click',
    (t) => {
      const p = harness.openPanel(t);
      const state = harness.stateMessage([harness.groupView()]);
      p.push(state);
      const gear = () => p.window.document.querySelector('#nav .gear');
      assert.ok(gear()?.classList.contains('survey-pending'));
      const dialog = modal(p);
      tab(dialog, 'Report');
      const report = dialog.querySelector('#settings-tab-report');
      assert.ok(report?.classList.contains('survey-pending'));
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('#settings-report button')];
      const survey = buttons[0];
      assert.ok(survey);
      assert.ok(survey.classList.contains('survey-pending'));
      buttons[1]?.click();
      buttons[2]?.click();
      assert.ok(gear()?.classList.contains('survey-pending'));
      assert.ok(report?.classList.contains('survey-pending'));
      survey.click();
      assert.equal(gear()?.classList.contains('survey-pending'), false);
      assert.equal(survey.classList.contains('survey-pending'), false);
      assert.equal(report?.classList.contains('survey-pending'), false);
      assert.deepEqual(p.posted.at(-1), { type: 'openExtensionPage', page: 'survey' });
      p.push(state);
      assert.equal(gear()?.classList.contains('survey-pending'), false);

      const reopened = harness.openPanel(t);
      for (let index = 0; index < p.window.localStorage.length; index++) {
        const key = p.window.localStorage.key(index);
        assert.ok(key);
        reopened.window.localStorage.setItem(key, p.window.localStorage.getItem(key)!);
      }
      assert.ok(reopened.window.localStorage.length, 'the click was persisted');
      reopened.push(state);
      assert.equal(reopened.window.document.querySelector('#nav .gear.survey-pending'), null);
      const reopenedDialog = modal(reopened);
      tab(reopenedDialog, 'Report');
      assert.equal(reopenedDialog.querySelector('#settings-report .survey-pending'), null);
      assert.equal(reopenedDialog.querySelector('#settings-tab-report.survey-pending'), null);
    }
  );

  test.it('opens seven category tabs with one selected page', (t) => {
    const p = harness.openPanel(t);
    p.push(harness.stateMessage([harness.groupView()]));
    const dialog = modal(p);
    assert.deepEqual(
      [...dialog.querySelectorAll('[role="tab"]')].map((item) => item.textContent),
      ['General', 'Accounts', 'Model', 'Appearance', 'Report', 'Changelog', 'About']
    );
    assert.equal(dialog.querySelectorAll('[role="tabpanel"]:not([hidden])').length, 1);
    tab(dialog, 'Model');
    assert.ok(dialog.querySelector('#settings-model:not([hidden]) .dual-config'));
  });

  test.it('closes on Escape without posting a session action', (t) => {
    const p = harness.openPanel(t);
    p.push(harness.stateMessage([harness.groupView()]));
    const dialog = modal(p);
    dialog.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.equal(dialog.open, false);
    assert.deepEqual(p.posted, []);
  });

  test.it('keeps the selected tab and control identity through unchanged state pushes', (t) => {
    const p = harness.openPanel(t);
    const state = harness.stateMessage([harness.groupView()]);
    p.push(state);
    const dialog = modal(p);
    tab(dialog, 'General');
    const control = dialog.querySelector('#settings-general .mrow');
    p.push(state);
    assert.equal(dialog.querySelector('#settings-general .mrow'), control);
    assert.equal(dialog.querySelector('[aria-selected="true"]')?.textContent, 'General');
  });

  test.it(
    'puts the account path note before the real account rows and hands login to auth',
    (t) => {
      const p = harness.openPanel(t);
      p.push(
        harness.stateMessage([harness.groupView()], {
          accounts: [
            {
              brand: 'codex',
              name: 'Codex',
              mark: 'codex',
              state: 'signed_out',
              label: 'Not signed in',
              detail: 'Codex'
            }
          ]
        })
      );
      const dialog = modal(p);
      tab(dialog, 'Accounts');
      const note = dialog.querySelector('.account-help');
      const account = dialog.querySelector('.acct');
      assert.ok(note && account);
      assert.ok(note.compareDocumentPosition(account) & p.window.Node.DOCUMENT_POSITION_FOLLOWING);
      account.querySelector<HTMLElement>('.act.in')?.click();
      assert.equal(dialog.open, false);
      assert.equal(p.window.document.querySelector<HTMLElement>('#ascrim')?.hidden, false);
      assert.deepEqual(p.posted.at(-1), { type: 'startLogin', brand: 'codex' });
      p.push({ type: 'loginProgress', brand: 'codex', phase: 'done' });
      assert.equal(dialog.open, true);
      assert.equal(dialog.querySelector('[aria-selected="true"]')?.textContent, 'Accounts');
    }
  );

  test.it("sets an account's usage windows beside its identity, not under it", (t) => {
    const p = harness.openPanel(t);
    p.push(
      harness.stateMessage([harness.groupView()], {
        accounts: [
          {
            brand: 'claude',
            name: 'Claude',
            mark: 'claude',
            state: 'signed_in',
            label: 'reader@example.com',
            detail: 'Claude',
            usage: {
              at: Date.now(),
              windows: [
                { id: 'session', short: '5h', pct: 12 },
                { id: 'weekly', short: 'wk', pct: 40 }
              ]
            }
          }
        ]
      })
    );
    const dialog = modal(p);
    tab(dialog, 'Accounts');
    const row = dialog.querySelector('.acct');
    assert.ok(row);
    assert.deepEqual(
      [...row.children].map((child) => child.className.split(' ')[0]),
      ['bmwrap', 'id', 'account-usage', 'act']
    );
    assert.equal(row.querySelectorAll('.account-usage > .win').length, 2);
  });

  test.it(
    'keeps open model choices attached through a changed configuration and consumes one Escape',
    (t) => {
      const p = harness.openPanel(t);
      const models = [
        {
          value: 'opus',
          id: 'opus',
          name: 'Opus',
          brand: 'claude' as const,
          efforts: [{ value: 'low' }, { value: 'high' }],
          defaultEffort: 'low'
        }
      ];
      p.push(harness.stateMessage([harness.groupView()], { models }));
      const dialog = modal(p);
      tab(dialog, 'Model');
      harness.switchRow(dialog, 'Default model').click();
      const choices = dialog.querySelector('.fmenu.fly:not([hidden])');
      assert.ok(choices);
      p.push(harness.stateMessage([harness.groupView()], { models, model: 'opus' }));
      assert.equal(dialog.querySelector('.fmenu.fly:not([hidden])'), choices);
      choices.dispatchEvent(
        new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      assert.equal(dialog.open, true);
      assert.equal(dialog.querySelector('.fmenu.fly:not([hidden])'), null);
      assert.deepEqual(p.posted, []);
    }
  );

  test.it(
    'restores setting focus after its host echo without exposing the busy session to Escape',
    (t) => {
      const p = harness.openThread(t, harness.threadView({ pid: 7, status: 'busy' }));
      const groups = [
        harness.groupView({ sessions: [harness.cardView({ pid: 7, status: 'busy' })] })
      ];
      p.push(harness.stateMessage(groups, { mascot: true }));
      const dialog = modal(p);
      const mascot = harness.switchRow(dialog, 'Mascot');
      mascot.focus();
      mascot.click();
      p.push(harness.stateMessage(groups, { mascot: false }));
      assert.equal(p.window.document.activeElement, harness.switchRow(dialog, 'Mascot'));
      p.window.document.dispatchEvent(
        new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      assert.equal(dialog.open, false);
      assert.equal(
        p.posted.some((message) => message.type === 'interrupt'),
        false
      );
    }
  );

  test.it('owns Escape even when focus has fallen outside the open modal', (t) => {
    const p = harness.openThread(t, harness.threadView({ pid: 7, status: 'busy' }));
    const dialog = modal(p);
    p.window.document.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.equal(dialog.open, false);
    assert.equal(
      p.posted.some((message) => message.type === 'interrupt'),
      false
    );
  });

  test.it('keeps a model-id edit open when Escape belongs to IME composition', (t) => {
    const p = harness.openPanel(t);
    p.push(harness.stateMessage([harness.groupView()]));
    const dialog = modal(p);
    tab(dialog, 'Model');
    harness.switchRow(dialog, 'Default model').click();
    dialog.querySelector<HTMLElement>('.fmenu.fly .ffoot .fbtn')?.click();
    const input = dialog.querySelector<HTMLInputElement>('.fmenu.fly input');
    assert.ok(input);
    input.value = 'custom-model';
    input.focus();
    input.dispatchEvent(new p.window.CompositionEvent('compositionstart', { bubbles: true }));
    for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
      input.dispatchEvent(
        new p.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
          ...extra
        })
      );
      assert.ok(dialog.querySelector('.fmenu.fly:not([hidden])'));
      assert.equal(input.isConnected, true);
      assert.equal(input.value, 'custom-model');
    }
    input.dispatchEvent(new p.window.CompositionEvent('compositionend', { bubbles: true }));
    input.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.equal(dialog.querySelector('.fmenu.fly:not([hidden])'), null);
    assert.equal(dialog.open, true);
    assert.deepEqual(p.posted, []);
  });

  test.it('opens the survey and the issue form from Report', (t) => {
    const p = harness.openPanel(t);
    p.push(harness.stateMessage([harness.groupView()]));
    const dialog = modal(p);
    tab(dialog, 'Report');
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('#settings-report button')];
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      ['Survey', 'Bugs', 'Request']
    );
    for (const button of buttons) button.click();
    assert.deepEqual(p.posted, [
      { type: 'openExtensionPage', page: 'survey' },
      { type: 'openExtensionPage', page: 'issue' },
      { type: 'openExtensionPage', page: 'issue' }
    ]);
  });

  test.it('shows release notes and posts named listing destinations from About', (t) => {
    const p = harness.openPanel(t);
    p.push(harness.stateMessage([harness.groupView()]));
    const dialog = modal(p);
    tab(dialog, 'Changelog');
    assert.ok(dialog.querySelector('.release summary'));
    tab(dialog, 'About');
    const link = dialog.querySelector<HTMLElement>('[data-page="marketplace"]');
    assert.ok(link);
    link.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openExtensionPage', page: 'marketplace' });
    const show = [...dialog.querySelectorAll<HTMLElement>('#settings-about button')].find(
      (button) => button.textContent === 'Show onboarding'
    );
    assert.ok(show);
    const style = p.window.getComputedStyle(show);
    assert.equal(style.cursor, 'pointer', 'the shared .b rank styles it, not the UA');
    assert.equal(style.borderRadius, '5px');
  });
});
