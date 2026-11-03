import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { panelStylesheet } from '../../ui/document';
import { cardView, groupView, openPanel, openThread, stateMessage, threadView } from '../harness';

const accountsSignedOut = (): AccountView[] => [
  {
    brand: 'claude',
    name: 'Claude',
    mark: 'claude',
    state: 'signed_out',
    label: 'Not signed in',
    detail: 'Claude'
  },
  grokSignedOut(),
  { brand: 'codex', name: 'Codex', mark: 'codex', state: 'coming_soon', detail: 'Coming soon' }
];

const grokSignedOut = (): AccountView => ({
  brand: 'grok',
  name: 'Grok',
  mark: 'grok',
  state: 'signed_out',
  label: 'Not signed in',
  detail: 'Grok'
});

const grokSignedIn = (): AccountView => ({
  brand: 'grok',
  name: 'Grok',
  mark: 'grok',
  state: 'signed_in',
  label: 'g@x.ai',
  detail: 'Grok · 1 session'
});

const accountsSignedIn = (usage?: UsageView): AccountView[] => [
  {
    brand: 'claude',
    name: 'Claude',
    mark: 'claude',
    state: 'signed_in',
    label: 'reader@example.com',
    detail: 'Claude · 1 session',
    plan: 'Max',
    usage
  },
  grokSignedIn(),
  { brand: 'codex', name: 'Codex', mark: 'codex', state: 'coming_soon', detail: 'Coming soon' }
];

/** Each window's row, flattened — `5h 12%`, `wk 43% resets 3d 6h`. */
const wins = (row: Element | undefined): string[] =>
  [...(row?.querySelectorAll('.win') ?? [])].map((w) =>
    (w.textContent ?? '').replace(/\s+/g, ' ').trim()
  );

describe('accounts — nav control', () => {
  it('shows Log in when every live brand is signed out', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { accounts: accountsSignedOut() }));
    const lim = p.window.document.querySelector<HTMLElement>('#nav .lim');
    assert.ok(lim);
    assert.equal(lim.tagName, 'BUTTON');
    assert.equal(lim.textContent, 'Log in');
    assert.ok(lim.classList.contains('login'));
  });

  it('shows Log in only when no live brand is signed in', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: [
          {
            brand: 'claude',
            name: 'Claude',
            mark: 'claude',
            state: 'signed_out',
            label: 'Not signed in',
            detail: 'Claude'
          },
          grokSignedIn(),
          {
            brand: 'codex',
            name: 'Codex',
            mark: 'codex',
            state: 'coming_soon',
            detail: 'Coming soon'
          }
        ]
      })
    );
    const lim = p.window.document.querySelector<HTMLElement>('#nav .lim');
    assert.ok(lim);
    assert.equal(lim.classList.contains('login'), false);
    assert.notEqual(lim.textContent, 'Log in');
  });

  it('keeps the usage chip when Claude is in and Grok is out', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        },
        accounts: [
          {
            brand: 'claude',
            name: 'Claude',
            mark: 'claude',
            state: 'signed_in',
            label: 'reader@example.com',
            detail: 'Claude · 1 session',
            plan: 'Max',
            usage: {
              windows: [
                { id: 'session', short: '5h', pct: 12 },
                { id: 'weekly', short: 'wk', pct: 78 }
              ]
            }
          },
          grokSignedOut(),
          {
            brand: 'codex',
            name: 'Codex',
            mark: 'codex',
            state: 'coming_soon',
            detail: 'Coming soon'
          }
        ]
      })
    );
    const lim = p.window.document.querySelector<HTMLElement>('#nav .lim');
    assert.ok(lim);
    assert.equal(lim.classList.contains('login'), false);
    assert.match(lim.textContent ?? '', /5h/);
  });

  it('keeps the passive usage span when accounts has not arrived yet', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    // Nothing to read before the first auth poll, because a reading rides an
    // account row and there is no row yet — but the slot is still the passive
    // span rather than a control that opens onto nothing.
    const lim = p.window.document.querySelector<HTMLElement>('#nav .lim');
    assert.equal(lim?.tagName, 'SPAN');
    assert.equal(lim?.textContent, '');
  });

  it('makes usage a button that opens the accounts popover', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView()] })], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        },
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        })
      })
    );
    const lim = p.window.document.querySelector<HTMLElement>('#nav .lim');
    assert.ok(lim);
    assert.equal(lim.tagName, 'BUTTON');
    assert.match(lim.textContent ?? '', /5h/);
    lim.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu, 'accounts flyout');
    assert.equal(menu.style.right, '0px', 'end-aligned under lim wrap');
    assert.equal(menu.style.left, 'auto');
    assert.match(menu.textContent ?? '', /Accounts/);
    assert.match(menu.textContent ?? '', /reader@example\.com/);
    assert.match(menu.textContent ?? '', /Sign out/);
    assert.match(menu.textContent ?? '', /Coming soon/);
    // Brand marks from media assets (SVG), not letter placeholders.
    assert.ok(menu.querySelector('svg.bm.cl'), 'Claude mark');
    assert.ok(menu.querySelector('svg.bm.gr'), 'Grok mark');
    assert.ok(menu.querySelector('svg.bm.cx'), 'Codex mark');
    assert.equal(menu.querySelectorAll('.bm.letter').length, 0);
    // Gear still has no Accounts section
    assert.ok(!menu.textContent?.includes('Board'));
  });

  it('opens the accounts popover from Log in, then Sign in starts login', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { accounts: accountsSignedOut() }));
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu, 'accounts flyout when signed out');
    assert.match(menu.textContent ?? '', /Accounts/);
    assert.match(menu.textContent ?? '', /Not signed in/);
    assert.match(menu.textContent ?? '', /Sign in/);
    assert.match(menu.textContent ?? '', /Coming soon/);
    // Claude and Grok Sign in; Codex is Soon.
    assert.equal(menu.querySelectorAll('button.act.in').length, 2);
    assert.ok(menu.querySelectorAll('.act.soon').length >= 1, 'Coming soon for Codex');
    const claudeIn = [...menu.querySelectorAll<HTMLButtonElement>('button.act.in')].find((b) =>
      b.closest('.acct')?.textContent?.includes('Claude')
    );
    claudeIn?.click();
    assert.ok(p.posted.some((m) => m.type === 'startLogin' && m.brand === 'claude'));
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden, 'login sheet from Sign in');
  });

  it('still opens the accounts menu after a signed-in → signed-out morph', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 10 },
            { id: 'weekly', short: 'wk', pct: 20 }
          ]
        },
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 10 },
            { id: 'weekly', short: 'wk', pct: 20 }
          ]
        })
      })
    );
    assert.equal(p.window.document.querySelector('#nav .lim')?.classList.contains('login'), false);
    p.push(stateMessage([groupView()], { accounts: accountsSignedOut() }));
    const lim = p.window.document.querySelector<HTMLElement>('#nav .lim');
    assert.ok(lim);
    assert.ok(lim.classList.contains('login'));
    lim.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu, 'popover after mode switch');
    assert.match(menu.textContent ?? '', /Sign in/);
    menu.querySelector<HTMLButtonElement>('button.act.in')?.click();
    assert.ok(p.posted.some((m) => m.type === 'startLogin' && m.brand === 'claude'));
  });

  it('paints 5h none on a signed-in Grok row and leaves Claude’s digits', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: [
          {
            brand: 'claude',
            name: 'Claude',
            mark: 'claude',
            state: 'signed_in',
            label: 'reader@example.com',
            detail: 'Claude',
            usage: {
              windows: [
                { id: 'session', short: '5h', pct: 12 },
                { id: 'weekly', short: 'wk', pct: 78 }
              ]
            }
          },
          {
            ...grokSignedIn(),
            usage: {
              windows: [
                { id: 'session', short: '5h', pct: null },
                { id: 'weekly', short: 'wk', pct: 32 }
              ]
            }
          },
          {
            brand: 'codex',
            name: 'Codex',
            mark: 'codex',
            state: 'coming_soon',
            detail: 'Coming soon'
          }
        ]
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const rows = [...p.window.document.querySelectorAll('.acct')];
    const claude = rows.find((r) => r.textContent?.includes('Claude'));
    const grok = rows.find((r) => r.textContent?.includes('Grok'));
    assert.deepEqual(wins(claude), ['5h 12%', 'wk 78%']);
    // `no 5h limit` and not `none`: the words the nav tip already prints for a
    // window this brand does not have, now that there is room to print them.
    assert.deepEqual(wins(grok), ['5h no 5h limit', 'wk 32%']);
  });

  // The tip has dated its reading since the host began stamping every one of
  // them; this popover is where two brands are read side by side.
  it('dates the reading on every signed-in row, whichever brand', (t) => {
    const p = openPanel(t);
    const usageAt = (at: number, pct: number): UsageView => ({
      at,
      windows: [
        { id: 'session', short: '5h', pct },
        { id: 'weekly', short: 'wk', pct }
      ]
    });
    p.push(
      stateMessage([groupView()], {
        accounts: [
          {
            brand: 'claude',
            name: 'Claude',
            mark: 'claude',
            state: 'signed_in',
            label: 'reader@example.com',
            detail: 'Claude · 1 session',
            usage: usageAt(Date.now() - 22 * 60 * 1000, 12)
          },
          { ...grokSignedIn(), usage: usageAt(Date.now() - 3 * 60 * 1000, 32) },
          {
            brand: 'codex',
            name: 'Codex',
            mark: 'codex',
            state: 'signed_in',
            label: 'reader@example.com',
            detail: 'Codex · 2 sessions',
            usage: usageAt(Date.now() - 90 * 1000, 4)
          }
        ]
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const rows = [...p.window.document.querySelectorAll('.acct')];
    const line = (name: string): string =>
      rows.find((r) => r.textContent?.includes(name))?.querySelector('.pl')?.textContent ?? '';
    assert.equal(line('Claude'), 'Claude · 1 session · updated 22m ago');
    assert.equal(line('Grok'), 'Grok · 1 session · updated 3m ago');
    assert.equal(line('Codex'), 'Codex · 2 sessions · updated 1m ago');
  });

  // Same rule the tip keeps, `at` being optional on the wire.
  it('says nothing about age on a row whose reading carries no stamp', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: accountsSignedIn({
          windows: [{ id: 'session', short: '5h', pct: 12 }]
        })
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const claude = [...p.window.document.querySelectorAll('.acct')].find((r) =>
      r.textContent?.includes('Claude')
    );
    assert.equal(claude?.querySelector('.pl')?.textContent, 'Claude · 1 session');
    assert.deepEqual(wins(claude), ['5h 12%']);
  });

  // The wire permits a stamped record with no windows in it. The age has its own
  // line now, so it lands whether or not a single window came with it.
  it('dates a reading that states no windows at all', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: accountsSignedIn({ at: Date.now() - 3 * 60 * 1000, windows: [] })
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const claude = [...p.window.document.querySelectorAll('.acct')].find((r) =>
      r.textContent?.includes('Claude')
    );
    assert.equal(claude?.querySelector('.pl')?.textContent, 'Claude · 1 session · updated 3m ago');
    assert.deepEqual(wins(claude), []);
  });

  it('wears the plan the host composed, cased as it was written', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: [
          {
            brand: 'claude',
            name: 'Claude',
            mark: 'claude',
            state: 'signed_in',
            label: 'reader@example.com',
            detail: 'Claude · 1 session',
            plan: 'Ultra'
          },
          {
            brand: 'codex',
            name: 'Codex',
            mark: 'codex',
            state: 'signed_in',
            label: 'reader@example.com',
            detail: 'Codex · 2 sessions',
            plan: 'Pro 5x'
          },
          grokSignedIn()
        ]
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const rows = [...p.window.document.querySelectorAll('.acct')];
    const chip = (name: string): string | undefined =>
      rows.find((r) => r.textContent?.includes(name))?.querySelector('.plan')?.textContent ??
      undefined;
    assert.equal(chip('Claude'), 'Ultra');
    assert.equal(chip('Codex'), 'Pro 5x');
    // Grok states no plan, so its row carries no chip rather than an empty one.
    assert.equal(chip('Grok'), undefined);

    // The two halves jsdom can actually fail on. `textContent` above is blind to
    // both: it ignores `text-transform`, and it ignores a class that styles
    // nothing — `plan max` was on every chip whatever the plan said.
    const claudeChip = rows.find((r) => r.textContent?.includes('Claude'))?.querySelector('.plan');
    assert.equal(claudeChip?.className, 'plan');
    const rule = panelStylesheet().match(/\.acct \.plan \{[^}]*\}/)?.[0] ?? '';
    assert.ok(rule, '.acct .plan rule');
    assert.doesNotMatch(rule, /text-transform/, 'uppercase would print MAX 20X');
  });

  // jsdom lays nothing out, so the scale and the row slot are read off the
  // stylesheet. A raw 9px or 11px is the wobble the three-step scale replaced,
  // and a span of 2 puts Sign out on the first window instead of the name.
  it('spends the type scale and keeps the action on the name line', () => {
    const css = panelStylesheet();
    const block = (head: string): string => {
      const at = css.indexOf(head);
      assert.ok(at >= 0, head);
      return css.slice(at, css.indexOf('}', at) + 1);
    };
    const plan = block('.acct .plan {');
    assert.match(plan, /font-size: var\(--av-fs-sm\)/);
    assert.doesNotMatch(plan, /9px/);
    const act = block('.acct .act {');
    assert.match(act, /font-size: var\(--av-fs-md\)/);
    assert.match(act, /grid-row: 1;/);
    assert.doesNotMatch(act, /span/);
    const acts = block('.acct .acts {');
    assert.match(acts, /grid-row: 1;/);
    assert.doesNotMatch(acts, /span/);
    assert.doesNotMatch(block('.acct {'), /grid-template-rows/);
    const mark = block('.acct .bmwrap {');
    assert.match(mark, /grid-row: 1;/);
    assert.doesNotMatch(mark, /span/);
    const value = block('.smenu.accts .mcpgo .v {');
    assert.match(value, /font-size: var\(--av-fs-md\)/);
    assert.doesNotMatch(value, /11px/);
  });

  // The chip used to be inline content inside `.em`, which is the clipped box,
  // so a label past ~24 characters pushed the badge under the ellipsis and it
  // vanished whole — `r.okonkwo@example.com` + `Max 20x` on a real account.
  // jsdom lays nothing out and cannot see that; what it can check is that the
  // clip has moved off the element the chip sits in. The geometry is
  // `panel.smoke.ts`.
  it('holds the plan chip outside the box the label is clipped in', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: accountsSignedIn({
          windows: [{ id: 'session', short: '5h', pct: 12 }]
        })
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const em = p.window.document.querySelector('.acct .em');
    assert.ok(em);
    // Label and chip are siblings, and only the label is in a clipped box.
    assert.equal(em.querySelector('.t')?.textContent, 'reader@example.com');
    assert.equal(em.querySelector('.plan')?.textContent, 'Max');
    assert.equal(em.querySelector('.t .plan'), null, 'chip inside the clipped span');

    const css = panelStylesheet();
    assert.doesNotMatch(
      css.match(/\.acct \.em \{[^}]*\}/)?.[0] ?? '',
      /text-overflow/,
      'clip still on the chip’s own box'
    );
    assert.match(css.match(/\.acct \.em \.t \{[^}]*\}/)?.[0] ?? '', /text-overflow: ellipsis/);
    assert.match(
      css.match(/\.acct \.plan \{[^}]*\}/)?.[0] ?? '',
      /flex: none/,
      'a shrinkable chip is a clipped chip'
    );
  });

  // `resetsAt` has been on the wire per window for every brand since the tip
  // learned to print it; the popover is where all three brands are read at once,
  // and it used to be the one place that did not say it. Same `until()` the tip
  // calls, so the two cannot drift.
  it('prints when each window turns over, per brand', (t) => {
    const p = openPanel(t);
    // Both sit mid-unit on purpose: `until` floors, so a reset landing exactly on
    // the minute prints one minute short the moment the clock moves under the
    // render — a flake that would only ever show up under load.
    const soon = Math.floor(Date.now() / 1000) + 2 * 3600 + 14 * 60 + 30;
    const later = Math.floor(Date.now() / 1000) + 3 * 86400 + 6 * 3600 + 1800;
    p.push(
      stateMessage([groupView()], {
        accounts: [
          {
            brand: 'claude',
            name: 'Claude',
            mark: 'claude',
            state: 'signed_in',
            label: 'reader@example.com',
            detail: 'Claude · 1 session',
            usage: {
              windows: [
                { id: 'session', short: '5h', pct: 10, resetsAt: soon },
                { id: 'weekly', short: 'wk', pct: 43, resetsAt: later }
              ]
            }
          },
          {
            ...grokSignedIn(),
            usage: {
              windows: [
                { id: 'session', short: '5h', pct: null, resetsAt: soon },
                { id: 'weekly', short: 'wk', pct: 50 }
              ]
            }
          }
        ]
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const rows = [...p.window.document.querySelectorAll('.acct')];
    assert.deepEqual(wins(rows.find((r) => r.textContent?.includes('Claude'))), [
      '5h 10% resets 2h 14m',
      'wk 43% resets 3d 6h'
    ]);
    assert.deepEqual(wins(rows.find((r) => r.textContent?.includes('Grok'))), [
      // A window the brand does not have has nothing to reset, whatever the
      // record says — a reset on a `none` would be a limit by implication.
      '5h no 5h limit',
      // A figure with no `resetsAt` simply says nothing, rather than guessing.
      'wk 50%'
    ]);
  });

  // `core/usage.ts` retires a figure the moment a later period is declared, so
  // the window keeps its name and its reset time and loses its number. That is
  // the reading the request was filed about — the tip prints the reset there
  // (`board_nav.ts`) and the popover used to be the one surface that did not,
  // which is the complaint it was supposed to answer.
  it('still says when a window turns over after a rollover took its figure', (t) => {
    const p = openPanel(t);
    const soon = Math.floor(Date.now() / 1000) + 2 * 3600 + 14 * 60 + 30;
    p.push(
      stateMessage([groupView()], {
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 12, resetsAt: soon },
            { id: 'weekly', short: 'wk', resetsAt: soon }
          ]
        })
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const claude = [...p.window.document.querySelectorAll('.acct')].find((r) =>
      r.textContent?.includes('Claude')
    );
    assert.deepEqual(wins(claude), ['5h 12% resets 2h 14m', 'wk - resets 2h 14m']);
    // The words give the reset back the cell it is aligned in. jsdom lays
    // nothing out, so that the two stay on one line is `accounts.smoke.ts`.
    const bare = [...(claude?.querySelectorAll('.win') ?? [])].at(-1)?.querySelector('.wv.bare');
    assert.ok(bare);
    assert.equal(bare.nextElementSibling?.className, 'wl');
    const rule =
      panelStylesheet().match(/\.acct \.win \.wv\.bare:not\(:last-child\) \{[^}]*\}/)?.[0] ?? '';
    assert.match(
      rule,
      /grid-column: 2 \/ span 2/,
      'the bare words keep the reset out of their span'
    );
  });

  it('draws a track only for a window that has a figure to draw', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 43 },
            { id: 'weekly', short: 'wk', pct: null },
            { id: 'monthly', short: 'mo' }
          ]
        })
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const claude = [...p.window.document.querySelectorAll('.acct')].find((r) =>
      r.textContent?.includes('Claude')
    );
    const bars = [...(claude?.querySelectorAll('.win') ?? [])].map(
      (w) => w.querySelector<HTMLElement>('.wb i')?.style.width
    );
    // An empty track on a window the brand does not have would read as 0% —
    // untouched — which is the opposite of what `null` says. `-` is a window
    // with no reading yet, and has no width to draw either.
    assert.deepEqual(bars, ['43%', undefined, undefined]);
    assert.deepEqual(wins(claude), ['5h 43%', 'wk no wk limit', 'mo -']);
  });

  /**
   * The track is a box of its own, and the fill spans the whole of it. Why the
   * track is `.wb` and not `.bar`, with the measurement: `css/nav.ts`, on the
   * rule. The painted width is smoke's (`accounts.smoke.ts`); this is the
   * cascade underneath it, and this is what `npm run check` runs.
   *
   * Both halves are asserted. Dropping `display: block` from the fill alone
   * puts it back inline, its `width: 61%` stops meaning anything, and the bug
   * is on screen again with the track still reading `block`.
   *
   * The fill assertion is the real one, and has no jsdom shape to it: an `i`
   * with no `display` of its own computes `inline` and paints 0px in a browser
   * too. Only the track assertion is approximate, and in two ways — in the
   * spirit of `containment.test.ts`:
   *
   * - **jsdom does not blockify.** A grid item with no `display` reads `inline`
   *   here and `block` in every engine that ships. So it pins the declaration
   *   rather than the behaviour — which is what we want of a declaration kept
   *   deliberately, but it is not the browser's answer.
   * - **jsdom's cascade is source order, not specificity.** A `.wb` rule
   *   appended to the last stylesheet in `panelStylesheet()` turns it red where
   *   a real engine would keep `block` at 0,3,0. The claim it actually canaries
   *   is "the last rule in the sheet naming this element", which sits near the
   *   real one without being it.
   */
  it('gives the usage track a box of its own, not the card bar’s grid', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: accountsSignedIn({
          windows: [{ id: 'session', short: '5h', pct: 22 }]
        })
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const claude = [...p.window.document.querySelectorAll('.acct')].find((r) =>
      r.textContent?.includes('Claude')
    );
    // Found through the fill rather than by class name, so the claim survives
    // the track being renamed again.
    const fill = claude?.querySelector<HTMLElement>('.win i');
    const track = fill?.parentElement;
    assert.ok(fill && track, 'a usage track to read');
    // Mode-free, both of them: this goes red as `grid` when the track takes the
    // card bar's rule and as `inline` when it takes nothing at all, and a
    // message naming either one is wrong two times in three.
    assert.equal(
      p.window.getComputedStyle(track).display,
      'block',
      'the track took another box’s display'
    );
    assert.equal(
      p.window.getComputedStyle(fill).display,
      'block',
      'the fill took another box’s display, so its width means nothing'
    );
  });

  it('ranks a window’s figure the way the nav chip ranks it', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 },
            { id: 'monthly', short: 'mo', pct: 98 }
          ]
        })
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const claude = [...p.window.document.querySelectorAll('.acct')].find((r) =>
      r.textContent?.includes('Claude')
    );
    const ranked = [...(claude?.querySelectorAll('.win') ?? [])].map((w) => [
      w.querySelector('.wv')?.className,
      w.querySelector('.wb i')?.className
    ]);
    assert.deepEqual(ranked, [
      ['wv', ''],
      ['wv high', 'high'],
      ['wv full', 'full']
    ]);
  });
});

describe('accounts — chat CTA', () => {
  it('draws a Log in CTA on an owned pipe thread when signed out', (t) => {
    const p = openThread(t, threadView({ pid: 5, owned: true, canSend: true, exchanges: [] }), {
      accounts: accountsSignedOut()
    });
    const cta = p.window.document.querySelector('.login-cta');
    assert.ok(cta, 'login CTA');
    assert.match(cta.textContent ?? '', /Not signed in to Claude/);
    cta.querySelector('button')?.click();
    assert.ok(p.posted.some((m) => m.type === 'startLogin' && m.brand === 'claude'));
  });

  it('draws a Grok login CTA on a Grok thread when Grok is signed out', (t) => {
    const p = openThread(
      t,
      threadView({ pid: 5, owned: true, brand: 'grok', who: 'grok', canSend: true, exchanges: [] }),
      { accounts: accountsSignedOut() }
    );
    const cta = p.window.document.querySelector('.login-cta');
    assert.ok(cta, 'login CTA');
    assert.match(cta.textContent ?? '', /Not signed in to Grok/);
    cta.querySelector('button')?.click();
    assert.ok(p.posted.some((m) => m.type === 'startLogin' && m.brand === 'grok'));
  });

  it('does not draw a Claude login CTA on a Grok thread when Grok is signed in', (t) => {
    const p = openThread(
      t,
      threadView({ pid: 5, owned: true, brand: 'grok', who: 'grok', canSend: true, exchanges: [] }),
      { accounts: accountsSignedIn() }
    );
    assert.equal(p.window.document.querySelector('.login-cta'), null);
  });

  it('does not draw the pipe CTA on a session this window cannot reach', (t) => {
    const p = openThread(t, threadView({ pid: 5, owned: false, canSend: false, exchanges: [] }), {
      accounts: accountsSignedOut()
    });
    assert.equal(p.window.document.querySelector('.login-cta'), null);
  });
});

describe('accounts — login and sign-out sheets', () => {
  for (const [fullCwd, leaf] of [
    ['c:\\Repo Mixed\\acme-web', 'acme-web'],
    ['\\\\server\\share\\acme-web', 'acme-web'],
    ['/repo/acme\\web', 'acme\\web'],
    ['//repo/share/acme\\web', 'acme\\web']
  ]) {
    it(`uses the path leaf for an unnamed sign-out row: ${fullCwd}`, (t) => {
      const p = openPanel(t);
      p.push(
        stateMessage([groupView({ sessions: [cardView({ name: '', fullCwd })] })], {
          accounts: accountsSignedIn()
        })
      );
      p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
      p.window.document
        .querySelector<HTMLElement>('#nav-actions .smenu.accts button.act.out')
        ?.click();
      assert.equal(
        p.window.document.querySelector('#ascrim .ablast > div')?.textContent?.trim(),
        leaf
      );
    });
  }
  for (const [code, masked] of [
    ['abcd.secret-middle.wxyz', 'abcd••••••••wxyz'],
    ['short', '•••••']
  ] as const) {
    it(`keeps ${code === 'short' ? 'short' : 'long'} submitted codes masked through progress and retry`, (t) => {
      const p = openPanel(t);
      p.push({ type: 'loginProgress', brand: 'claude', phase: 'paste' });
      const field = (): HTMLInputElement => {
        const input = p.window.document.querySelector<HTMLInputElement>('#ascrim input.acode');
        assert.ok(input);
        return input;
      };
      const submit = (): HTMLButtonElement => {
        const button = p.window.document.querySelector<HTMLButtonElement>('#ascrim .asfoot .pri');
        assert.ok(button);
        return button;
      };
      assert.equal(field().type, 'password');
      assert.equal(field().getAttribute('aria-label'), 'Authorization code');
      field().value = ` ${code} `;
      field().dispatchEvent(new p.window.Event('input', { bubbles: true }));
      p.push({ type: 'loginProgress', brand: 'claude', url: 'https://example.com/login' });
      assert.equal(field().value, ` ${code} `, 'a URL update preserves the draft');
      field().dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert.deepEqual(p.posted.at(-1), { type: 'submitLoginCode', code });
      assert.equal(field().type, 'text');
      assert.equal(field().value, masked, 'submission immediately shows a masked receipt');
      assert.equal(field().disabled, true);
      assert.equal(submit().disabled, true);
      assert.equal(submit().textContent, 'Checking…');
      const sent = p.posted.length;
      submit().click();
      assert.equal(p.posted.length, sent, 'no duplicate submit while checking');
      p.push({ type: 'loginProgress', brand: 'claude', phase: 'waiting' });
      assert.equal(field().value, masked, 'the host progress repaint preserves the receipt');
      assert.ok(!JSON.stringify(p.saved() ?? {}).includes(code), 'the code is not persisted');
      p.push({ type: 'loginProgress', brand: 'claude', phase: 'error', message: 'Invalid code.' });
      assert.equal(field().type, 'password');
      assert.equal(field().value, code, 'retry edits the original code, never the mask');
      field().value = 'replacement-code';
      field().dispatchEvent(new p.window.Event('input', { bubbles: true }));
      submit().click();
      assert.deepEqual(p.posted.at(-1), { type: 'submitLoginCode', code: 'replacement-code' });
      p.push({ type: 'loginProgress', brand: 'claude', phase: 'done' });
      assert.equal(p.window.document.querySelector<HTMLElement>('#ascrim')?.hidden, true);
      p.push({ type: 'loginProgress', brand: 'claude', phase: 'paste' });
      assert.equal(field().value, '', 'a later login has no previous code');
    });
  }

  it('paints the paste-code sheet from loginProgress and posts submit/cancel', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { accounts: accountsSignedOut() }));
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    p.window.document
      .querySelector<HTMLButtonElement>('#nav-actions .smenu.accts:not([hidden]) button.act.in')
      ?.click();
    // Local starting paint before the host answers.
    const scrim = (): HTMLElement | null => p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim() && !scrim()!.hidden, 'login sheet open');
    assert.match(scrim()!.textContent ?? '', /Sign in to Claude/);

    const authUrl = 'https://claude.com/cai/oauth/authorize?code=true&client_id=test';
    p.push({
      type: 'loginProgress',
      brand: 'claude',
      phase: 'browser',
      url: authUrl
    });
    p.push({ type: 'loginProgress', brand: 'claude', phase: 'paste' });
    const root = scrim()!;
    const input = root.querySelector<HTMLInputElement>('input.acode');
    assert.ok(input, 'code field');
    assert.match(root.textContent ?? '', /claude\.com\/cai\/oauth/);
    // Open browser is reader-initiated, not auto.
    root.querySelectorAll('button').forEach((b) => {
      if (b.textContent === 'Open browser') b.click();
    });
    assert.ok(
      p.posted.some((m) => m.type === 'openLoginUrl' && m.url === authUrl),
      'openLoginUrl from Open browser'
    );
    input.value = 'abc.def';
    root.querySelector<HTMLButtonElement>('.asfoot button.pri')?.click();
    assert.ok(p.posted.some((m) => m.type === 'submitLoginCode' && m.code === 'abc.def'));

    p.push({ type: 'loginProgress', brand: 'claude', phase: 'error', message: 'Invalid code.' });
    assert.match(scrim()!.textContent ?? '', /Invalid code/);

    const cancel = [...(scrim()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Cancel'
    );
    cancel?.click();
    assert.ok(p.posted.some((m) => m.type === 'cancelLogin'));
    assert.ok(scrim()?.hidden, 'sheet closed');
  });

  it('opens the sign-out confirm from the accounts menu and posts confirmSignOut', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage(
        [groupView({ sessions: [cardView({ name: 'mid-turn work', status: 'busy' })] })],
        {
          accounts: accountsSignedIn({
            windows: [
              { id: 'session', short: '5h', pct: 12 },
              { id: 'weekly', short: 'wk', pct: 78 }
            ]
          })
        }
      )
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu);
    menu.querySelector<HTMLButtonElement>('button.act.out')?.click();
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden);
    assert.match(scrim.textContent ?? '', /Sign out of Claude/);
    assert.match(scrim.textContent ?? '', /mid-turn work/);
    assert.match(scrim.textContent ?? '', /mid-turn/);
    scrim.querySelector<HTMLButtonElement>('.asfoot button.dgr')?.click();
    assert.ok(p.posted.some((m) => m.type === 'confirmSignOut' && m.brand === 'claude'));
    assert.equal(scrim.hidden, false, 'stays up while signing out');
    assert.match(scrim.textContent ?? '', /Signing out/);
    assert.equal(scrim.querySelector('.ax'), null, 'no X while the CLI is running');
    scrim.click();
    assert.equal(scrim.hidden, false, 'backdrop must not drop the wait');
    p.push({ type: 'signOutResult', brand: 'claude', phase: 'done' });
    assert.ok(scrim.hidden, 'done closes the sheet');
  });

  it('tags a session waiting on a dialog, and not one that is idle', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage(
        [
          groupView({
            sessions: [
              cardView({ pid: 201, name: 'needs a decision', status: 'waiting' }),
              cardView({ pid: 202, name: 'sitting quiet', status: 'idle' })
            ]
          })
        ],
        { accounts: accountsSignedIn() }
      )
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    p.window.document
      .querySelector<HTMLButtonElement>('#nav-actions .smenu.accts:not([hidden]) button.act.out')
      ?.click();
    const lines = [...p.window.document.querySelectorAll<HTMLElement>('#ascrim .ablast > div')];
    assert.match(lines[0]?.textContent ?? '', /needs a decision/);
    assert.equal(lines[0]?.querySelector('.atag')?.textContent, 'mid-turn');
    assert.match(lines[1]?.textContent ?? '', /sitting quiet/);
    assert.equal(lines[1]?.querySelector('.atag'), null);
  });

  it('paints the device-code sheet from loginProgress with a userCode', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { accounts: accountsSignedOut() }));
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    const grokIn = [...(menu?.querySelectorAll<HTMLButtonElement>('button.act.in') ?? [])].find(
      (b) => b.closest('.acct')?.textContent?.includes('Grok')
    );
    grokIn?.click();
    assert.ok(p.posted.some((m) => m.type === 'startLogin' && m.brand === 'grok'));
    const scrim = (): HTMLElement | null => p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.match(scrim()!.textContent ?? '', /Sign in to Grok/);

    const authUrl = 'https://accounts.x.ai/oauth2/device?user_code=CGB6-Y7VF';
    p.push({
      type: 'loginProgress',
      brand: 'grok',
      phase: 'waiting',
      url: authUrl,
      userCode: 'CGB6-Y7VF'
    });
    const root = scrim()!;
    assert.equal(root.querySelector('input.acode'), null, 'no paste field');
    assert.equal(
      [...root.querySelectorAll('button')].some((b) => b.textContent === 'Submit'),
      false,
      'no Submit'
    );
    assert.match(root.textContent ?? '', /accounts\.x\.ai\/oauth2\/device/);
    assert.equal(root.querySelector('.ucode span')?.textContent, 'CGB6-Y7VF');
    assert.ok(
      [...root.querySelectorAll('.ucode button')].some((b) => b.textContent === 'Copy'),
      'the code is copyable, not only readable'
    );
    assert.match(root.textContent ?? '', /Confirm this code/);

    p.push({ type: 'loginProgress', brand: 'grok', phase: 'waiting' });
    assert.ok(scrim() && !scrim()!.hidden, 'waiting keeps the sheet');
    const waiting = scrim()!;
    waiting.click();
    assert.equal(waiting.hidden, false, 'backdrop must not cancel a wait on the browser');
    p.window.document.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    assert.equal(waiting.hidden, false, 'Escape must not cancel a wait on the browser');
    const cancel = [...(scrim()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Cancel'
    );
    cancel?.click();
    assert.ok(p.posted.some((m) => m.type === 'cancelLogin'));
  });

  it('paints a Grok login error without a paste field', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { accounts: accountsSignedOut() }));
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    const grokIn = [...(menu?.querySelectorAll<HTMLButtonElement>('button.act.in') ?? [])].find(
      (b) => b.closest('.acct')?.textContent?.includes('Grok')
    );
    grokIn?.click();
    p.push({
      type: 'loginProgress',
      brand: 'grok',
      phase: 'error',
      message: "Couldn't find the grok CLI."
    });
    const root = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(root && !root.hidden);
    assert.match(root.textContent ?? '', /Couldn't find the grok CLI/);
    assert.equal(root.querySelector('input.acode'), null, 'no paste field');
    assert.equal(
      [...root.querySelectorAll('button')].some((b) => b.textContent === 'Submit'),
      false,
      'no Submit'
    );
    assert.doesNotMatch(root.textContent ?? '', /Paste the code here/);
  });

  it('closes the device-code sheet on done', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { accounts: accountsSignedOut() }));
    p.push({
      type: 'loginProgress',
      brand: 'grok',
      phase: 'waiting',
      url: 'https://accounts.x.ai/oauth2/device?user_code=NEJB-B6C2',
      userCode: 'NEJB-B6C2'
    });
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden);
    p.push({ type: 'loginProgress', brand: 'grok', phase: 'done' });
    assert.ok(scrim.hidden);
  });

  // The order every CLI emits in: `url` first, then that CLI's own phase in the
  // same tick (`claude/auth.ts` emitUrl, `codex/auth.ts` login/start,
  // `grok/auth.ts` reader). So a push carrying a URL and no phase lands on
  // whatever step the sheet is already on, and must not move it.
  it('keeps the starting step when a url push carries no phase', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { accounts: accountsSignedOut() }));
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    p.window.document
      .querySelector<HTMLButtonElement>('#nav-actions .smenu.accts:not([hidden]) button.act.in')
      ?.click();
    const scrim = (): HTMLElement => p.window.document.querySelector<HTMLElement>('#ascrim')!;
    assert.match(scrim().textContent ?? '', /Starting sign-in/);

    const authUrl = 'https://claude.com/cai/oauth/authorize?code=true&client_id=test';
    p.push({ type: 'loginProgress', brand: 'claude', url: authUrl });
    // The frame this adds: the starting body, now with a door under it. No paste
    // box yet — that is the adapter's next push to state, not this one's.
    assert.match(scrim().textContent ?? '', /Starting sign-in/);
    assert.match(scrim().textContent ?? '', /claude\.com\/cai\/oauth/);
    assert.equal(scrim().querySelector('input.acode'), null, 'no paste box yet');
    assert.ok(
      [...scrim().querySelectorAll('button')].some((b) => b.textContent === 'Cancel'),
      'the starting footer keeps its one way out'
    );

    p.push({ type: 'loginProgress', brand: 'claude', phase: 'browser' });
    assert.ok(scrim().querySelector('input.acode'), 'the paste box arrives with the phase');
  });

  it('keeps a device-code wait through a url push that revises the code', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()], { accounts: accountsSignedOut() }));
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    [...(menu?.querySelectorAll<HTMLButtonElement>('button.act.in') ?? [])]
      .find((b) => b.closest('.acct')?.textContent?.includes('Grok'))
      ?.click();
    const scrim = (): HTMLElement => p.window.document.querySelector<HTMLElement>('#ascrim')!;
    assert.match(scrim().textContent ?? '', /Sign in to Grok/);

    // Grok's real sequence: the door with no phase on it, then the phase.
    const url = 'https://accounts.x.ai/oauth2/device?user_code=NEJB-B6C2';
    p.push({ type: 'loginProgress', brand: 'grok', url, userCode: 'NEJB-B6C2' });
    p.push({ type: 'loginProgress', brand: 'grok', phase: 'waiting' });
    const confirmStep = (): HTMLElement | undefined =>
      [...scrim().querySelectorAll<HTMLElement>('.astep')].find((row) =>
        row.querySelector('.ad')?.textContent?.includes('Confirm this code')
      );
    assert.equal(confirmStep()?.querySelector('.k')?.textContent, '…', 'waiting marker');

    // Grok re-sends the URL to attach a code read off a later line, and sends no
    // phase behind it — the one push in the whole flow where nothing else says
    // what step the sheet is on.
    p.push({ type: 'loginProgress', brand: 'grok', url, userCode: 'CGB6-Y7VF' });
    assert.equal(scrim().querySelector('.ucode span')?.textContent, 'CGB6-Y7VF', 'revised code');
    assert.equal(confirmStep()?.querySelector('.k')?.textContent, '…', 'still waiting');
    assert.equal(scrim().querySelector('input.acode'), null, 'no paste field');
  });

  it('lists only that brand’s cards on the sign-out confirm', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage(
        [
          groupView({
            sessions: [
              cardView({ name: 'claude work', brand: 'claude', status: 'busy' }),
              cardView({ name: 'grok work', brand: 'grok', pid: 202 })
            ]
          })
        ],
        {
          accounts: [
            {
              brand: 'claude',
              name: 'Claude',
              mark: 'claude',
              state: 'signed_in',
              label: 'reader@example.com',
              detail: 'Claude · 1 session'
            },
            grokSignedIn(),
            {
              brand: 'codex',
              name: 'Codex',
              mark: 'codex',
              state: 'coming_soon',
              detail: 'Coming soon'
            }
          ]
        }
      )
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    const grokOut = [...(menu?.querySelectorAll<HTMLButtonElement>('button.act.out') ?? [])].find(
      (b) => b.closest('.acct')?.textContent?.includes('Grok')
    );
    grokOut?.click();
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden);
    assert.match(scrim.textContent ?? '', /Sign out of Grok/);
    assert.match(scrim.textContent ?? '', /grok work/);
    assert.doesNotMatch(scrim.textContent ?? '', /claude work/);
    scrim.querySelector<HTMLButtonElement>('.asfoot button.dgr')?.click();
    assert.ok(p.posted.some((m) => m.type === 'confirmSignOut' && m.brand === 'grok'));
    assert.match(scrim.textContent ?? '', /Signing out/);
  });

  it('keeps the sign-out sheet on error so the failure is on the panel', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ name: 'mid-turn work' })] })], {
        accounts: accountsSignedIn()
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    p.window.document
      .querySelector<HTMLButtonElement>('#nav-actions .smenu.accts:not([hidden]) button.act.out')
      ?.click();
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden);
    scrim.querySelector<HTMLButtonElement>('.asfoot button.dgr')?.click();
    p.push({
      type: 'signOutResult',
      brand: 'claude',
      phase: 'error',
      message: 'Logout timed out.'
    });
    assert.equal(scrim.hidden, false);
    assert.match(scrim.textContent ?? '', /Sign out of Claude failed/);
    assert.match(scrim.textContent ?? '', /Logout timed out/);
    assert.ok(scrim.querySelector('.ax'), 'error unlocks dismiss');
    const close = [...scrim.querySelectorAll('button')].find((b) => b.textContent === 'Close');
    close?.click();
    assert.ok(scrim.hidden);
  });
});

describe('accounts — lock and wait on every live brand', () => {
  const brands: { brand: BrandId; name: string; userCode?: string }[] = [
    { brand: 'claude', name: 'Claude' },
    { brand: 'grok', name: 'Grok', userCode: 'CGB6-Y7VF' },
    { brand: 'codex', name: 'Codex', userCode: 'CDX5-SMOK' }
  ];

  const rows = (state: 'signed_in' | 'signed_out'): AccountView[] =>
    brands.map((b) => ({
      brand: b.brand,
      name: b.name,
      mark: b.brand,
      state,
      label: state === 'signed_in' ? `${b.name.toLowerCase()}@example.com` : 'Not signed in',
      detail: b.name
    }));

  const act = (
    p: ReturnType<typeof openPanel>,
    name: string,
    cls: 'in' | 'out'
  ): HTMLButtonElement | undefined =>
    [...p.window.document.querySelectorAll<HTMLButtonElement>(`button.act.${cls}`)].find((b) =>
      b.closest('.acct')?.textContent?.includes(name)
    );

  for (const b of brands) {
    it(`does not dismiss an in-flight ${b.name} login on backdrop or Escape`, (t) => {
      const p = openPanel(t);
      p.push(stateMessage([groupView()], { accounts: rows('signed_out') }));
      p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
      act(p, b.name, 'in')?.click();
      p.push({
        type: 'loginProgress',
        brand: b.brand,
        phase: 'waiting',
        url: 'https://example.test/oauth',
        ...(b.userCode ? { userCode: b.userCode } : {})
      });
      const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
      assert.ok(scrim && !scrim.hidden);
      assert.match(scrim.textContent ?? '', new RegExp(`Sign in to ${b.name}`));
      assert.equal(scrim.querySelector('.ax'), null, 'no X while the child is running');
      scrim.click();
      assert.equal(scrim.hidden, false, 'backdrop must not cancel a wait on the browser');
      p.window.document.dispatchEvent(
        new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      assert.equal(scrim.hidden, false, 'Escape must not cancel a wait on the browser');
    });

    it(`holds the ${b.name} sign-out wait until the host answers`, (t) => {
      const p = openPanel(t);
      p.push(stateMessage([groupView()], { accounts: rows('signed_in') }));
      p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
      act(p, b.name, 'out')?.click();
      const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
      assert.ok(scrim && !scrim.hidden);
      scrim.querySelector<HTMLButtonElement>('.asfoot button.dgr')?.click();
      assert.ok(p.posted.some((m) => m.type === 'confirmSignOut' && m.brand === b.brand));
      assert.match(scrim.textContent ?? '', /Signing out/);
      assert.equal(scrim.querySelector('.ax'), null);
      scrim.click();
      assert.equal(scrim.hidden, false);
      p.push({ type: 'signOutResult', brand: b.brand, phase: 'done' });
      assert.ok(scrim.hidden);
    });
  }
});

describe('accounts — name and mark ride the row', () => {
  it('paints a Coming-soon name the host sent, not a capitalised brand', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: [
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
            name: 'Not Derived',
            mark: 'grok',
            state: 'coming_soon',
            detail: 'Coming soon'
          }
        ]
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu);
    assert.match(menu.textContent ?? '', /Not Derived/);
    assert.doesNotMatch(menu.textContent ?? '', /(?<![A-Za-z])Grok(?![A-Za-z])/);
  });

  it('offers Sign in on a signed-out row that is not Claude, and posts that brand', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: [
          {
            brand: 'grok',
            name: 'Grok',
            mark: 'grok',
            state: 'signed_out',
            label: 'Not signed in',
            detail: 'Grok'
          },
          {
            brand: 'claude',
            name: 'Claude',
            mark: 'claude',
            state: 'coming_soon',
            detail: 'Coming soon'
          }
        ]
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu);
    assert.equal(menu.querySelectorAll('button.act.in').length, 1);
    menu.querySelector<HTMLButtonElement>('button.act.in')?.click();
    assert.ok(p.posted.some((m) => m.type === 'startLogin' && m.brand === 'grok'));
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden);
    assert.match(scrim.textContent ?? '', /Sign in to Grok/);
  });

  it('does not name other brands on the sign-out sheet', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ name: 'mid-turn work' })] })], {
        accounts: accountsSignedIn()
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    p.window.document
      .querySelector<HTMLButtonElement>('#nav-actions .smenu.accts:not([hidden]) button.act.out')
      ?.click();
    const scrim = p.window.document.querySelector<HTMLElement>('#ascrim');
    assert.ok(scrim && !scrim.hidden);
    assert.match(scrim.textContent ?? '', /Other accounts on this machine are unaffected/);
    assert.doesNotMatch(scrim.textContent ?? '', /Grok/);
    assert.doesNotMatch(scrim.textContent ?? '', /Codex/);
  });
});

describe('accounts — hold open across state push', () => {
  it('keeps accounts popover open across a state push (like settings)', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        },
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        })
      })
    );
    const lim = p.window.document.querySelector<HTMLElement>('#nav .lim');
    assert.ok(lim);
    lim.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu, 'open before push');
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 13 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        },
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 13 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        })
      })
    );
    assert.ok(p.window.document.body.contains(menu), 'state push detached accounts menu');
    assert.equal(menu.hidden, false, 'state push closed accounts menu');
    assert.match(menu.textContent ?? '', /Accounts/);
  });

  // The order a real host actually arrives in, and the one every case here
  // used to skip: the board push lands before the auth poll answers, so the
  // usage slot is a passive span for one paint and the accounts wrap replaces
  // it on the next. Both carried `data-key="usage"`, so morphdom mutated the
  // span in place and adopted the wrap's children into it — leaving the wrap
  // `opensMenu` closed over outside the document, `heldOpen(nav)` false for
  // this control alone, and the next repaint morphing the open menu shut.
  it('keeps accounts open when the wrap replaced a passive usage span', (t) => {
    const p = openPanel(t);
    const board = (accounts?: AccountView[]) =>
      stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })], {
        ...(accounts ? { accounts } : {})
      });
    p.push(board());
    assert.equal(
      p.window.document.querySelector<HTMLElement>('#nav .lim')?.tagName,
      'SPAN',
      'passive span before the auth poll'
    );
    p.push(
      board(
        accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        })
      )
    );
    const lim = p.window.document.querySelector<HTMLElement>('#nav button.lim');
    assert.ok(lim, 'accounts control after the auth poll');
    lim.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu, 'open before push');
    // The transition itself, and the one assertion that states it: the popover
    // must hang off the wrap that was built for it. A collided key leaves the
    // menu adopted into the old span instead — never detached, so `contains`
    // cannot see it, and the closed menu below is only the consequence.
    assert.ok(
      menu.parentElement?.classList.contains('limwrap'),
      'accounts menu was adopted into the passive span'
    );
    p.push(
      board(
        accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        })
      )
    );
    assert.equal(menu.hidden, false, 'state push closed accounts menu');
    assert.match(menu.textContent ?? '', /Accounts/);
  });

  it('keeps accounts open when thread content changes on a push', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        },
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        }),
        thread: threadView({ pid: 7 })
      })
    );
    p.window.document.querySelector<HTMLElement>('[data-pid="7"]')?.click();
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu, 'open before chat update');
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 79 }
          ]
        },
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 79 }
          ]
        }),
        thread: threadView({
          pid: 7,
          exchanges: [
            { role: 'user', text: 'hi', blocks: [] },
            { role: 'assistant', text: 'hello', blocks: [] }
          ]
        })
      })
    );
    assert.ok(p.window.document.body.contains(menu), 'chat update detached accounts menu');
    assert.equal(menu.hidden, false, 'chat update closed accounts menu');
  });

  it('holds nav still while open — usage digits freeze', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        },
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        })
      })
    );
    const lim = p.window.document.querySelector<HTMLElement>('#nav .lim');
    assert.ok(lim);
    lim.click();
    const before = lim.textContent;
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 99 },
            { id: 'weekly', short: 'wk', pct: 99 }
          ]
        },
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 99 },
            { id: 'weekly', short: 'wk', pct: 99 }
          ]
        })
      })
    );
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu, 'menu still open');
    assert.equal(lim.textContent, before, 'heldOpen should freeze lim digits');
  });

  it('cards scroll closes accounts (same as any menu)', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        },
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        })
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    assert.ok(p.window.document.querySelector('#nav-actions .smenu.accts:not([hidden])'), 'open');
    const cards = p.window.document.getElementById('cards');
    assert.ok(cards);
    cards.dispatchEvent(new p.window.Event('scroll', { bubbles: true }));
    const menu = p.window.document.querySelector<HTMLElement>('#nav-actions .smenu.accts');
    assert.ok(menu?.hidden, 'cards scroll should closeMenu');
  });

  it('stays open when usage hits full rank (out of quota style push)', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 88 },
            { id: 'weekly', short: 'wk', pct: 88 }
          ]
        },
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 88 },
            { id: 'weekly', short: 'wk', pct: 88 }
          ]
        }),
        thread: threadView({ pid: 7, canSend: true })
      })
    );
    p.window.document.querySelector<HTMLElement>('[data-pid="7"]')?.click();
    const lim = p.window.document.querySelector<HTMLElement>('#nav .lim');
    assert.ok(lim);
    lim.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu, 'open');
    // Out of usage: lim digits go red (full), accounts nested usage maxes,
    // thread may carry a CLI error turn — none of that should drop the hold.
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 7, status: 'idle' })] })], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 100 },
            { id: 'weekly', short: 'wk', pct: 100 }
          ]
        },
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 100 },
            { id: 'weekly', short: 'wk', pct: 100 }
          ]
        }),
        thread: threadView({
          pid: 7,
          canSend: true,
          exchanges: [
            { role: 'user', text: 'hi', blocks: [] },
            {
              role: 'assistant',
              text: 'You have hit your limit · resets 4h 12m',
              blocks: []
            }
          ]
        })
      })
    );
    assert.equal(menu.hidden, false, 'full usage push closed accounts menu');
    assert.ok(p.window.document.body.contains(menu));
    // heldOpen freezes lim, so digits stay pre-full until reopen
    assert.match(lim.textContent ?? '', /88/);
  });

  it('selecting a session closes an open accounts menu (openDock → closeMenu)', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })], {
        usage: {
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        },
        accounts: accountsSignedIn({
          windows: [
            { id: 'session', short: '5h', pct: 12 },
            { id: 'weekly', short: 'wk', pct: 78 }
          ]
        })
      })
    );
    const lim = p.window.document.querySelector<HTMLElement>('#nav .lim');
    assert.ok(lim);
    lim.click();
    assert.equal(lim.getAttribute('aria-expanded'), 'true');
    // Clicking a card selects it and openDock('chat') → setDockTab → closeMenu().
    p.window.document.querySelector<HTMLElement>('[data-pid="7"]')?.click();
    // After close + nav morph the trigger is rebuilt; find lim again.
    const lim2 = p.window.document.querySelector<HTMLElement>('#nav .lim');
    assert.ok(lim2);
    assert.equal(lim2.getAttribute('aria-expanded'), 'false', 'select should closeMenu');
    assert.ok(
      !p.window.document.querySelector('#nav-actions .smenu.accts:not([hidden])'),
      'no visible accounts menu after select'
    );
  });
});

describe('accounts — a CLI that is not installed', () => {
  const openCodexMissing = (t: TestContext) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView()], {
        accounts: [
          {
            brand: 'codex',
            name: 'Codex',
            mark: 'codex',
            state: 'not_installed',
            label: 'Not installed',
            detail: 'Codex'
          }
        ]
      })
    );
    p.window.document.querySelector<HTMLElement>('#nav .lim')?.click();
    const menu = p.window.document.querySelector<HTMLElement>(
      '#nav-actions .smenu.accts:not([hidden])'
    );
    assert.ok(menu);
    return { p, row: menu.querySelector<HTMLElement>('.acct') };
  };

  it('says so, muted, and offers no sign-in', (t) => {
    const { row } = openCodexMissing(t);
    assert.ok(row);
    assert.match(row.textContent ?? '', /Not installed/);
    assert.ok(row.querySelector('.bmwrap.muted'));
    assert.ok(row.querySelector('.em.muted'));
    assert.doesNotMatch(row.textContent ?? '', /Sign in/);
  });

  it('opens that brand’s install page from Install', (t) => {
    const { p, row } = openCodexMissing(t);
    row?.querySelector<HTMLButtonElement>('button.act.install')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'installCli', brand: 'codex' });
  });

  it('opens that brand’s path setting from Set path', (t) => {
    const { p, row } = openCodexMissing(t);
    row?.querySelector<HTMLButtonElement>('button.act.path')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'setCliPath', brand: 'codex' });
  });
});
