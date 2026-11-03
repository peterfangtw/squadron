import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cardView, groupView, openPanel, openThread, stateMessage, threadView } from '../harness';

/** The primitive is exercised through the auth sheet — first caller, same chrome. */

const signedOut = (): AccountView[] => [
  {
    brand: 'claude',
    name: 'Claude',
    mark: 'claude',
    state: 'signed_out',
    label: 'Not signed in',
    detail: 'Claude'
  },
  {
    brand: 'grok',
    name: 'Grok',
    mark: 'grok',
    state: 'signed_out',
    label: 'Not signed in',
    detail: 'Grok'
  },
  { brand: 'codex', name: 'Codex', mark: 'codex', state: 'coming_soon', detail: 'Coming soon' }
];

const signedIn = (): AccountView[] => [
  {
    brand: 'claude',
    name: 'Claude',
    mark: 'claude',
    state: 'signed_in',
    label: 'reader@example.com',
    detail: 'Claude · 1 session'
  },
  {
    brand: 'grok',
    name: 'Grok',
    mark: 'grok',
    state: 'signed_in',
    label: 'g@x.ai',
    detail: 'Grok · 1 session'
  },
  { brand: 'codex', name: 'Codex', mark: 'codex', state: 'coming_soon', detail: 'Coming soon' }
];

function openLogin(t: Parameters<typeof openPanel>[0]) {
  const p = openPanel(t);
  p.push(stateMessage([groupView()], { accounts: signedOut() }));
  p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
  const claudeIn = [...p.window.document.querySelectorAll<HTMLButtonElement>('button.act.in')].find(
    (b) => b.closest('.acct')?.textContent?.includes('Claude')
  );
  claudeIn?.click();
  return p;
}

function escapeOn(p: ReturnType<typeof openPanel>): void {
  p.window.document.dispatchEvent(
    new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
}

describe('sheet', () => {
  it('keeps a refused Escape from the session behind it', (t) => {
    // Locked is a refusal, not a pass: the key is still the sheet's, and a
    // busy session in the dock must not take it instead.
    const p = openThread(t, threadView({ pid: 7, status: 'busy' }), { accounts: signedOut() });
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    [...p.window.document.querySelectorAll<HTMLButtonElement>('button.act.in')]
      .find((b) => b.closest('.acct')?.textContent?.includes('Claude'))
      ?.click();
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden, 'the login sheet did not open');
    p.window.document.body.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.equal(scrim.hidden, false);
    assert.equal(p.posted.filter((m) => m.type === 'interrupt').length, 0);
  });

  it('is a dialog, named by its title', (t) => {
    const p = openLogin(t);
    const sheet = p.window.document.querySelector<HTMLElement>('#ascrim .asheet');
    assert.ok(sheet, 'the login sheet did not open');
    assert.equal(sheet.getAttribute('role'), 'dialog');
    const id = sheet.getAttribute('aria-labelledby') ?? '';
    const name = p.window.document.getElementById(id);
    assert.ok(name && sheet.contains(name), 'the sheet is named by nothing inside it');
    assert.equal(name.textContent, sheet.querySelector('.ashead b')?.textContent);
  });

  it('does not dismiss an in-flight login on Escape, backdrop, or X', (t) => {
    const p = openLogin(t);
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden);
    assert.equal(scrim.querySelector('.ax'), null, 'no X while the child is running');
    escapeOn(p);
    assert.equal(scrim.hidden, false, 'Escape left the wait in place');
    scrim.click();
    assert.equal(scrim.hidden, false, 'a board click left the wait in place');
    assert.equal(
      p.posted.some((m) => m.type === 'cancelLogin'),
      false,
      'accidental dismiss must not kill the child'
    );
  });

  it('Cancel still ends an in-flight login', (t) => {
    const p = openLogin(t);
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden);
    const cancel = [...scrim.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
    cancel?.click();
    assert.ok(scrim.hidden);
    assert.ok(p.posted.some((m) => m.type === 'cancelLogin'));
  });

  it('Escape and backdrop dismiss a login that failed', (t) => {
    const p = openLogin(t);
    p.push({
      type: 'loginProgress',
      brand: 'claude',
      phase: 'error',
      message: 'Sign in did not finish.'
    });
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden);
    assert.ok(scrim.querySelector('.ax'), 'X returns once there is nothing to wait on');
    escapeOn(p);
    assert.ok(scrim.hidden, 'Escape dismisses a failed sheet');
    assert.ok(p.posted.some((m) => m.type === 'cancelLogin'));
  });

  it('a backdrop press dismisses a failed login the same way', (t) => {
    const p = openLogin(t);
    p.push({
      type: 'loginProgress',
      brand: 'claude',
      phase: 'error',
      message: 'Sign in did not finish.'
    });
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden);
    scrim.click();
    assert.ok(scrim.hidden);
    assert.ok(p.posted.some((m) => m.type === 'cancelLogin'));
  });

  it('Escape still dismisses the sign-out confirm', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ name: 'mid-turn work' })] })], {
        accounts: signedIn()
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    p.window.document
      .querySelector<HTMLButtonElement>('#nav-actions .smenu.accts:not([hidden]) button.act.out')
      ?.click();
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden);
    assert.ok(scrim.querySelector('.ax'), 'confirm is not in-flight work');
    escapeOn(p);
    assert.ok(scrim.hidden, 'confirm still cancels without posting');
    assert.equal(
      p.posted.some((m) => m.type === 'confirmSignOut'),
      false
    );
  });
});
