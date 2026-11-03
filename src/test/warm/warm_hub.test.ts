import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cardView,
  groupView,
  openPanel,
  stateMessage,
  switchLabel,
  switchedOn,
  workflowView
} from '../harness';
import type { Panel } from '../harness';

/**
 * Warm on the bottom drawer. The nav bar no longer carries the control.
 * What the host decided arrives on `CardView.warm`; these scenarios hold what
 * the sheet says, what the bar counts, and what a switch posts. Whether the
 * open frame is on screen, and whether each column scrolls, is `warm.smoke.ts`.
 */

const HOUR = 60 * 60_000;
/** A minute and a half clear of the floor, so the minute a countdown shows
 *  is the same however long the push and paint take. */
const inMinutes = (m: number): number => Date.now() + m * 60_000 + 30_000;
const warm = (over: Partial<WarmView> = {}): WarmView => ({
  on: false,
  ttlMs: HOUR,
  source: 'measured',
  ...over
});
const card = (pid: number, w: WarmView, over: Partial<CardView> = {}) =>
  cardView({ pid, name: 'session ' + pid, warm: w, ...over });
/** Figures off every default but Codex's, so a paint read off the bundle's
 *  defaults instead of the push cannot pass. */
const pushedConfig = (): WarmConfigView => {
  const figure = (key: string, minutes: number, defaultMinutes: number, max: number) => ({
    key,
    minutes,
    defaultMinutes,
    min: key === 'buffer' ? 1 : key === 'window' ? 10 : 2,
    max
  });
  return {
    ttl: [
      {
        ...figure('ttl:claude', 25, 60, 180),
        brand: 'claude',
        name: 'Claude',
        source: 'configured',
        tip: 'c'
      },
      {
        ...figure('ttl:codex', 30, 30, 180),
        brand: 'codex',
        name: 'Codex',
        source: 'measured',
        tip: 'x'
      },
      {
        ...figure('ttl:grok', 12, 15, 180),
        brand: 'grok',
        name: 'Grok',
        source: 'configured',
        tip: 'g'
      }
    ],
    buffer: figure('buffer', 3, 5, 30),
    window: figure('window', 90, 120, 480)
  };
};

const $ = (p: Panel, sel: string): HTMLElement | null =>
  p.window.document.querySelector<HTMLElement>(sel);

const button = (p: Panel): HTMLElement => {
  const node = $(p, '#bottomhub .warm-tab');
  assert.ok(node, 'no Warm button on the bottom hub');
  return node;
};
const escape = (p: Panel): void => {
  p.window.document.dispatchEvent(
    new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  );
};
/** Open Warm from shut. The bar is not a control while the sheet is up. */
const open = (p: Panel): HTMLElement => {
  const sheet = p.window.document.getElementById('bottomdrawer');
  if (sheet && !sheet.hidden) p.window.document.getElementById('bottomdrawer-close')?.click();
  button(p).click();
  const opened = p.window.document.getElementById('bottomdrawer');
  assert.ok(opened && !opened.hidden, 'Warm opened no sheet');
  return opened;
};
const rows = (sheet: HTMLElement): HTMLElement[] => [
  ...sheet.querySelectorAll<HTMLElement>('.sessions .mrow')
];
const row = (sheet: HTMLElement, name: string): HTMLElement => {
  const found = rows(sheet).find((r) => switchLabel(r) === name);
  assert.ok(found, `no "${name}" row in Warm`);
  return found;
};
const detail = (r: HTMLElement): string | null | undefined => r.querySelector('.d')?.textContent;
const clause = (r: HTMLElement): HTMLElement | null => r.querySelector<HTMLElement>('.d .st');
const defaultRow = (sheet: HTMLElement): HTMLElement => {
  const found = sheet.querySelector<HTMLElement>('.bdlist > [data-key="warm:default"]');
  assert.ok(found, 'no New sessions switch under the list');
  return found;
};
const count = (p: Panel): string => button(p).querySelector('.num')?.textContent ?? '';
const tally = (p: Panel): HTMLElement | null => $(p, '#bottomdrawer .bdlist .column-head .summary');

const steps = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    label: `Step ${i + 1}`,
    prompt: `do step ${i + 1}`
  }));

describe('Warm on the bottom drawer', () => {
  it('shares pending choices between the card and the open Warm switches', (t) => {
    const p = openPanel(t);
    const one = card(7, warm());
    p.push(stateMessage([groupView({ sessions: [one] })]));
    const cardSwitch = (): HTMLElement => {
      const control = $(p, '.card [data-act="warm"]');
      assert.ok(control);
      return control;
    };
    cardSwitch().click();
    const sheet = open(p);
    assert.equal(switchedOn(row(sheet, 'session 7')), true);
    assert.equal(count(p), '1');
    row(sheet, 'session 7').click();
    assert.equal(cardSwitch().getAttribute('aria-pressed'), 'false');
    assert.equal($(p, '.card')?.classList.contains('warm-on'), false);
    assert.equal(count(p), '0');
    p.window.document.getElementById('bottomdrawer-close')?.click();
    cardSwitch().click();
    open(p);
    assert.equal(switchedOn(row(sheet, 'session 7')), true);
    p.push({ type: 'warmChoice', pid: 7, startedAt: one.startedAt });
    assert.equal(switchedOn(row(sheet, 'session 7')), false);
    assert.equal(cardSwitch().getAttribute('aria-pressed'), 'false');
  });

  it('is not on the nav bar', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [card(1, warm({ on: true }))] })]));
    assert.equal($(p, '#nav-actions .wcache'), null);
    assert.equal($(p, '#nav-actions .wmenu'), null);
  });

  it('counts the sessions whose switch is on, never the ones it refuses', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            card(1, warm({ on: true, nextAt: inMinutes(14), endsAt: Date.now() + HOUR })),
            card(2, warm({ on: true, held: 'ask', endsAt: Date.now() + HOUR })),
            card(3, warm()),
            card(4, warm({ held: 'unsupported' }), { canControl: false })
          ]
        })
      ])
    );
    const control = button(p);
    assert.equal(count(p), '2');
    assert.equal(control.querySelector('.tmark'), null);
    assert.equal(control.getAttribute('aria-haspopup'), null);
    assert.deepEqual(JSON.parse(control.dataset.tipRows ?? '[]'), [
      ['kept warm', '2 of 4', ''],
      ['held', '1', ''],
      ['next ping', 'in 14m', '']
    ]);
    open(p);
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Warm');
    assert.equal(tally(p)?.textContent, '2 of 4 kept warm');
    assert.equal(
      tally(p)?.parentElement?.querySelector('.column-title')?.textContent,
      'Sessions in this window',
      'the count sits beside the switches it counts'
    );
    assert.equal($(p, '#bottomdrawer-head .summary'), null, 'the sheet head carries no count');
    const note = p.window.document.getElementById('bottomdrawer-note');
    assert.equal(note?.hidden, false);
    assert.match(
      note?.textContent ?? '',
      /Keep idle sessions' prompt caches warm for up to 2h after the last real turn/
    );
    assert.equal(note?.closest('#bottomdrawer-body'), null, 'the note sits inside a column');
    assert.equal(
      note?.parentElement?.id,
      'bottomdrawer-head',
      'the policy line sits in the header'
    );
  });

  it('counts a flip the host has not echoed, and drops it when the host refuses', (t) => {
    const p = openPanel(t);
    const one = card(7, warm());
    p.push(stateMessage([groupView({ sessions: [one] })]));
    assert.equal(count(p), '0');
    const sheet = open(p);
    row(sheet, 'session 7').click();
    assert.equal(count(p), '1');
    assert.equal(tally(p)?.textContent, '1 of 1 kept warm');
    p.push({ type: 'warmChoice', pid: 7, startedAt: one.startedAt });
    p.push(stateMessage([groupView({ sessions: [one] })]));
    assert.equal(count(p), '0');
    assert.equal(switchedOn(row(sheet, 'session 7')), false);
    assert.equal(tally(p)?.textContent, '0 of 1 kept warm');
  });

  it('draws no dead word beside a live Warm, Remote and Agents', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [card(1, warm())] })]));
    assert.equal(p.window.document.querySelector('#bottomhub .hpill[aria-disabled="true"]'), null);
    assert.equal(button(p).getAttribute('aria-disabled'), null);
    assert.ok($(p, '#bottomhub .remote-tab'), 'no Remote word');
    assert.equal($(p, '#bottomhub .remote-tab')?.getAttribute('aria-disabled'), null);
    assert.equal($(p, '#bottomhub .agents-tab')?.getAttribute('aria-disabled'), null);
  });

  it('opens on an empty workflow list, beside + New workflow', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [card(1, warm())] })]));
    assert.match($(p, '#bottomhub')?.textContent ?? '', /\+ New workflow/);
    assert.equal($(p, '#bottomhub .wmore'), null);
    const sheet = open(p);
    assert.equal(sheet.hidden, false);
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Warm');
    assert.ok(row(sheet, 'session 1'));
  });

  it('shows workflow rows from Workflows and Warm columns from Warm, each from shut', (t) => {
    const p = openPanel(t);
    const workflows = [workflowView({ id: 'ship', label: 'plan→build', steps: steps(2) })];
    p.push(stateMessage([groupView({ sessions: [card(1, warm())] })], { workflows }));
    $(p, '#bottomhub .wmore')?.click();
    assert.equal($(p, '#bottomdrawer')?.hidden, false);
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Workflows');
    assert.equal(tally(p), null);
    const note = p.window.document.getElementById('bottomdrawer-note');
    assert.equal(note?.hidden, false);
    assert.match(note?.textContent ?? '', /^Compose a workflow/);
    assert.ok($(p, '#bottomdrawer .wsrow'));
    p.window.document.getElementById('bottomdrawer-close')?.click();
    assert.ok($(p, '#bottomdrawer')?.hidden);
    const sheet = open(p);
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Warm');
    assert.equal($(p, '#bottomdrawer .wsrow'), null);
    assert.ok(row(sheet, 'session 1'));
    assert.equal(p.window.document.getElementById('bottomdrawer-filter')?.hidden, true);
    assert.equal(p.window.document.getElementById('bottomdrawer-foot')?.hidden, true);
  });

  it('stays available with no session, and keeps New sessions', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [] })]));
    assert.equal(count(p), '0');
    const sheet = open(p);
    assert.equal(
      sheet.querySelector('.sessions .fnone')?.textContent,
      'No sessions in this window yet.'
    );
    assert.equal(switchLabel(defaultRow(sheet)), 'New sessions');
    assert.equal(tally(p)?.textContent ?? '', '');
  });

  it('lists each session with its lifetime, its source and the next ping', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            card(1, warm({ on: true, nextAt: inMinutes(14), endsAt: Date.now() + HOUR })),
            card(2, warm({ on: true, ttlMs: 15 * 60_000, source: 'configured' })),
            card(3, warm({ ttlMs: 30 * 60_000 })),
            card(5, warm({ source: 'measured' }))
          ]
        })
      ])
    );
    const sheet = open(p);
    assert.equal(detail(row(sheet, 'session 1')), '1h · measured · ping in 14m');
    assert.equal(clause(row(sheet, 'session 1'))?.className, 'st next');
    assert.match(detail(row(sheet, 'session 2')) ?? '', /^15m · configured · /);
    assert.match(detail(row(sheet, 'session 3')) ?? '', /^30m · measured · /);
    assert.match(detail(row(sheet, 'session 5')) ?? '', /^1h · measured · /);
    assert.equal(switchedOn(row(sheet, 'session 1')), true);
    assert.equal(switchedOn(row(sheet, 'session 3')), false);
    assert.equal(row(sheet, 'session 1').getAttribute('role'), 'switch');
  });

  it('says what a cache that is not being pinged is doing', (t) => {
    const p = openPanel(t);
    const ago = (m: number) => Date.now() - m * 60_000;
    p.push(
      stateMessage([
        groupView({
          sessions: [
            card(1, warm(), { updatedAt: ago(38), cacheUntil: inMinutes(22) }),
            card(2, warm(), { updatedAt: ago(90), cacheUntil: ago(30) }),
            card(3, warm({ on: true, endsAt: ago(1) }), {
              updatedAt: ago(121),
              cacheUntil: ago(61)
            }),
            card(4, warm({ on: true, nextAt: ago(0), endsAt: Date.now() + HOUR })),
            card(5, warm({ on: true, held: 'warming', endsAt: Date.now() + HOUR })),
            card(6, warm({ on: true, held: 'busy' }), { status: 'busy' })
          ]
        })
      ])
    );
    const sheet = open(p);
    const said = (name: string) => [
      clause(row(sheet, name))?.className,
      clause(row(sheet, name))?.textContent
    ];
    assert.deepEqual(said('session 1'), ['st quiet', 'warm for 22m']);
    assert.deepEqual(said('session 2'), ['st cold', 'cold']);
    assert.deepEqual(said('session 3'), ['st quiet', 'warms from the next turn']);
    assert.deepEqual(said('session 4'), ['st next', 'pinging now']);
    assert.deepEqual(said('session 5'), ['st next', 'pinging now']);
    assert.deepEqual(said('session 6'), ['st quiet', 'working']);
  });

  it('says why a held row is waiting, in the reason the host held it for', (t) => {
    const p = openPanel(t);
    const held = (pid: number, reason: WarmHeldView, over: Partial<CardView> = {}) =>
      card(pid, warm({ on: true, held: reason, endsAt: Date.now() + HOUR }), over);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            held(1, 'ask'),
            held(2, 'queued'),
            held(4, 'no-cache'),
            held(5, 'window-short'),
            held(6, 'failed')
          ]
        })
      ])
    );
    const sheet = open(p);
    const said = (name: string) => clause(row(sheet, name))?.textContent;
    assert.equal(said('session 1'), 'Warm blocked: waiting on you');
    assert.equal(said('session 2'), 'Warm blocked: a message is queued');
    assert.equal(said('session 4'), 'Warm blocked: no cache yet');
    assert.equal(said('session 5'), 'window too short to ping');
    assert.equal(clause(row(sheet, 'session 5'))?.className, 'st no');
    assert.equal(said('session 6'), 'Warm blocked: last ping failed');
    assert.equal(clause(row(sheet, 'session 1'))?.className, 'st held');
    assert.equal(row(sheet, 'session 1').getAttribute('aria-disabled'), null);
  });

  it('posts setWarm for the session a switch names', (t) => {
    const p = openPanel(t);
    const one = card(7, warm());
    p.push(stateMessage([groupView({ sessions: [one] })]));
    const r = row(open(p), 'session 7');
    r.click();
    assert.deepEqual(p.posted, [{ type: 'setWarm', pid: 7, startedAt: one.startedAt, on: true }]);
    assert.equal(switchedOn(r), true);
  });

  it('reconciles a refused flip while Warm stays open', (t) => {
    const p = openPanel(t);
    const one = card(7, warm());
    p.push(stateMessage([groupView({ sessions: [one] })]));
    const sheet = open(p);
    row(sheet, 'session 7').click();
    assert.equal(switchedOn(row(sheet, 'session 7')), true);
    p.push({ type: 'warmChoice', pid: 7, startedAt: one.startedAt });
    p.push(stateMessage([groupView({ sessions: [one] })]));
    assert.equal(switchedOn(row(sheet, 'session 7')), false);
    assert.equal(sheet.hidden, false);
  });

  it('reconciles a stale incarnation response without changing the recycled row', (t) => {
    const p = openPanel(t);
    const one = card(7, warm(), { startedAt: 100 });
    p.push(stateMessage([groupView({ sessions: [one] })]));
    const sheet = open(p);
    row(sheet, 'session 7').click();
    p.push({ type: 'warmChoice', pid: 7, startedAt: 100 });
    p.push(stateMessage([groupView({ sessions: [card(7, warm(), { startedAt: 200 })] })]));
    assert.equal(switchedOn(row(sheet, 'session 7')), false);
    assert.equal(sheet.hidden, false);
  });

  it('refuses the switch on a session nothing here can keep warm, and says why', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            card(1, warm({ held: 'unsupported' }), { canControl: false }),
            card(2, warm({ held: 'unsupported' }))
          ]
        })
      ])
    );
    assert.equal(count(p), '0');
    const sheet = open(p);
    const background = row(sheet, 'session 1');
    assert.equal(background.getAttribute('aria-disabled'), 'true');
    assert.equal(clause(background)?.className, 'st no');
    assert.equal(clause(background)?.textContent, 'background session · nothing here can reach it');
    assert.equal(clause(row(sheet, 'session 2'))?.textContent, 'this session cannot be kept warm');
    assert.equal(detail(background), 'background session · nothing here can reach it');
    background.click();
    assert.deepEqual(p.posted, []);
    assert.equal(switchedOn(background), false);
  });

  it('sets the default for new sessions from the pinned switch, not the count', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [card(1, warm())] })], { warmCache: false }));
    const sheet = open(p);
    const foot = defaultRow(sheet);
    assert.equal(foot.closest('.sessions'), null, 'New sessions scrolls away with the rows');
    assert.equal(switchedOn(foot), false);
    assert.equal(foot.querySelector('.tag')?.textContent, 'beta');
    assert.equal(foot.getAttribute('role'), 'switch');
    foot.click();
    assert.deepEqual(p.posted, [{ type: 'setFlag', key: 'warmCache', on: true }]);
    assert.equal(count(p), '0');
    p.push(stateMessage([groupView({ sessions: [card(1, warm())] })], { warmCache: true }));
    assert.equal(switchedOn(defaultRow(sheet)), true);
    assert.equal(sheet.hidden, false);
  });

  it('retires the New sessions flip on an agreeing push that lands while Warm is shut', (t) => {
    const p = openPanel(t);
    const board = [groupView({ sessions: [card(1, warm())] })];
    p.push(stateMessage(board, { warmCache: false }));
    defaultRow(open(p)).click();
    escape(p);
    p.push(stateMessage(board, { warmCache: true }));
    // Turned off again from the Settings UI.
    p.push(stateMessage(board, { warmCache: false }));
    assert.equal(switchedOn(defaultRow(open(p))), false, 'the flip outlived the push that agreed');
  });

  it('puts New sessions back when the host could not write the setting', (t) => {
    const p = openPanel(t);
    const board = [groupView({ sessions: [card(1, warm())] })];
    p.push(stateMessage(board, { warmCache: false }));
    const sheet = open(p);
    defaultRow(sheet).click();
    assert.equal(switchedOn(defaultRow(sheet)), true);
    p.push({ type: 'flagChoice', key: 'warmCache', on: true, landed: false });
    assert.equal(switchedOn(defaultRow(sheet)), false, 'a refused write left the flip on screen');
    assert.equal(sheet.hidden, false);
  });

  it('holds New sessions through a write the host took, until a push agrees', (t) => {
    const p = openPanel(t);
    const board = [groupView({ sessions: [card(1, warm())] })];
    p.push(stateMessage(board, { warmCache: false }));
    const sheet = open(p);
    defaultRow(sheet).click();
    p.push({ type: 'flagChoice', key: 'warmCache', on: true, landed: true });
    p.push(stateMessage(board, { warmCache: false }));
    assert.equal(switchedOn(defaultRow(sheet)), true, 'a push from before the write took the flip');
  });

  it('repaints an open list in place, keeping the focus and a flip not yet echoed', (t) => {
    const p = openPanel(t);
    const first = card(1, warm({ on: true, nextAt: inMinutes(14), endsAt: Date.now() + HOUR }));
    const second = card(2, warm());
    p.push(stateMessage([groupView({ sessions: [first, second] })]));
    const sheet = open(p);
    const flipped = row(sheet, 'session 2');
    flipped.click();
    flipped.focus();
    const moved = card(1, warm({ on: true, held: 'ask', endsAt: Date.now() + HOUR }));
    p.push(stateMessage([groupView({ sessions: [moved, second] })]));
    assert.equal(sheet.hidden, false);
    assert.equal(row(sheet, 'session 2'), flipped, 'the focused row was replaced');
    assert.equal(p.window.document.activeElement, flipped, 'the focus left the row');
    assert.equal(switchedOn(flipped), true, 'a stale push took the flip back');
    assert.equal(clause(row(sheet, 'session 1'))?.textContent, 'Warm blocked: waiting on you');
    p.push(stateMessage([groupView({ sessions: [moved, card(2, warm({ on: true }))] })]));
    assert.equal(switchedOn(flipped), true);
    p.push(stateMessage([groupView({ sessions: [card(2, warm({ on: true }))] })]));
    assert.deepEqual(rows(sheet).map(switchLabel), ['session 2']);
  });

  it('shuts from Escape, the backdrop and the close control, back on the Warm button', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [card(1, warm()), card(2, warm())] })]));
    const doc = p.window.document;
    const warmButton = button(p);
    warmButton.click();
    assert.equal(warmButton.getAttribute('aria-expanded'), 'true');
    escape(p);
    assert.ok($(p, '#bottomdrawer')?.hidden, 'Escape left Warm open');
    assert.equal(doc.activeElement, warmButton);
    assert.equal(warmButton.getAttribute('aria-expanded'), 'false');

    warmButton.click();
    $(p, '#bottomdrawer-scrim')?.click();
    assert.ok($(p, '#bottomdrawer')?.hidden, 'the backdrop left Warm open');
    assert.equal(doc.activeElement, warmButton);

    warmButton.click();
    doc.getElementById('bottomdrawer-close')?.click();
    assert.ok($(p, '#bottomdrawer')?.hidden, 'close left Warm open');
    assert.equal(doc.activeElement, warmButton);
  });

  it('keeps drawing Warm while it slides shut, and Workflows reopens as itself', (t) => {
    const p = openPanel(t);
    const workflows = [workflowView({ id: 'ship', label: 'plan→build', steps: steps(2) })];
    p.push(stateMessage([groupView({ sessions: [card(1, warm())] })], { workflows }));
    open(p);
    $(p, '#bottomdrawer-close')?.click();
    const sheet = $(p, '#bottomdrawer');
    assert.ok(sheet?.hidden);
    const mark = sheet.querySelector('.ttl-field .bmwrap svg');
    assert.ok(mark, 'closing cleared the configuration column');
    assert.equal(p.window.getComputedStyle(mark).width, '13px');
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Warm');
    assert.equal($(p, '#bottomdrawer-note')?.hidden, false);
    assert.equal($(p, '#bottomdrawer-foot')?.hidden, true);

    $(p, '#bottomhub .wmore')?.click();
    assert.equal(sheet.hidden, false);
    assert.equal($(p, '#bottomdrawer-head .ttl')?.textContent, 'Workflows');
    assert.equal($(p, '#bottomdrawer-note')?.hidden, false);
    assert.match($(p, '#bottomdrawer-note')?.textContent ?? '', /^Compose a workflow/);
    assert.equal($(p, '#bottomdrawer-foot')?.hidden, false);
    assert.equal(sheet.querySelector('.ttl-field'), null);
    assert.ok(sheet.querySelector('.wsrow'));
  });

  it('heads the rows by folder only when sessions run in more than one', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [card(1, warm()), card(2, warm())] })]));
    assert.equal(open(p).querySelectorAll('.mhead.dir').length, 0);
    p.push(
      stateMessage([
        groupView({ label: 'app', cwd: '/w/app', sessions: [card(1, warm())] }),
        groupView({ label: 'site', cwd: '/w/site', sessions: [card(2, warm())] })
      ])
    );
    const heads = [...open(p).querySelectorAll('.mhead.dir')].map((h) => h.textContent);
    assert.deepEqual(heads, ['app', 'site']);
  });

  it('shows the pushed cache table in fields, with buffer details only in its tooltip', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [card(1, warm())] })], { warmConfig: pushedConfig() })
    );
    const sheet = open(p);
    const config = sheet.querySelector('.bddetail');
    assert.ok(config);
    assert.deepEqual(
      [...config.querySelectorAll('.ttl-field .label')].map((n) => n.textContent),
      ['Claude TTL', 'Codex TTL', 'Grok TTL', 'Ping buffer', 'Keep warm for']
    );
    assert.deepEqual(
      [...config.querySelectorAll<HTMLInputElement>('.ttl-field .minutes input')].map(
        (n) => n.value
      ),
      ['25', '30', '12', '3', '90']
    );
    assert.deepEqual(
      [...config.querySelectorAll('.ttl-field .minutes')].map((n) => n.textContent),
      ['min', 'min', 'min', '−min', 'min']
    );
    const text = config.textContent ?? '';
    assert.doesNotMatch(text, /reported|measured|configured/);
    const ttl = [...config.querySelectorAll('.ttl-field:not(.buffer):not(.window)')];
    assert.deepEqual(
      ttl.map((field) => field.querySelector('.why')?.getAttribute('data-tip')),
      ['c', 'x', 'g']
    );
    assert.deepEqual(
      ttl.map((field) => field.querySelector('.why')?.getAttribute('aria-label')),
      ['c', 'x', 'g']
    );
    assert.deepEqual(
      ttl.map((field) => {
        const mark = field.querySelector('.bm');
        if (mark?.classList.contains('cl')) return 'cl';
        if (mark?.classList.contains('cx')) return 'cx';
        if (mark?.classList.contains('gr')) return 'gr';
        return '';
      }),
      ['cl', 'cx', 'gr']
    );
    assert.equal(config.querySelector('.ttl-field:not(.buffer) .source'), null);
    assert.equal(config.querySelector('.ttl-field.buffer .source'), null);
    const bufferTip = config.querySelector('.ttl-field.buffer .why');
    const explanation = 'Before cache expiry. Each ping runs 3 minutes before the TTL ends.';
    assert.equal(bufferTip?.getAttribute('data-tip'), explanation);
    assert.equal(bufferTip?.getAttribute('aria-label'), explanation);
    assert.equal(bufferTip?.tagName, 'BUTTON');
    assert.doesNotMatch(text, /Before cache expiry|Each ping runs|Ping intervals/);
    assert.match(
      p.window.document.getElementById('bottomdrawer-note')?.textContent ?? '',
      /warm for up to 1h 30m after the last real turn/,
      'the note reads the pushed window'
    );
  });

  it("tips each TTL with its brand's own line, and no source word", (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [card(1, warm())] })], { warmConfig: pushedConfig() })
    );
    const sheet = open(p);
    const ttl = [...sheet.querySelectorAll('.bddetail .ttl-field:not(.buffer):not(.window)')];
    const tips = ['c', 'x', 'g'];
    assert.deepEqual(
      ttl.map((field) => field.querySelector('.why')?.getAttribute('data-tip')),
      tips
    );
    assert.deepEqual(
      ttl.map((field) => field.querySelector('.why')?.getAttribute('aria-label')),
      tips
    );
  });

  it('advances an open countdown and the bar tip on the 1s beat, with no push', async (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            card(1, warm({ on: true, nextAt: Date.now() + 60_500, endsAt: Date.now() + HOUR }))
          ]
        })
      ])
    );
    const sheet = open(p);
    assert.equal(clause(row(sheet, 'session 1'))?.textContent, 'ping in 1m');
    assert.match(button(p).dataset.tipRows ?? '', /"in 1m"/);
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(clause(row(sheet, 'session 1'))?.textContent, 'ping in 59s');
    assert.match(button(p).dataset.tipRows ?? '', /"in 59s"/);
  });
});

/**
 * The configuration column's figures, typed in place. Typing is the only way a
 * value moves: no stepper, no wheel. A commit is a blur, Enter, or nothing.
 */
describe('Warm configuration fields', () => {
  /** `pushedConfig` with Claude's TTL at `claude`, the figure these edit. */
  const configWith = (claude: number): WarmConfigView => {
    const config = pushedConfig();
    const [first, ...rest] = config.ttl;
    assert.ok(first);
    return { ...config, ttl: [{ ...first, minutes: claude }, ...rest] };
  };
  const pushConfig = (p: Panel, config: WarmConfigView, sessions = [card(1, warm())]): void => {
    p.push(stateMessage([groupView({ sessions })], { warmConfig: config }));
  };
  const field = (p: Panel, label: string): HTMLInputElement => {
    const input = p.window.document.querySelector<HTMLInputElement>(
      `#bottomdrawer .bddetail input[aria-label="${label}"]`
    );
    assert.ok(input, `no "${label}" field in the configuration column`);
    return input;
  };
  /** Focus and type the way a keystroke lands: the text, then `input`. */
  const type = (p: Panel, input: HTMLInputElement, text: string): void => {
    if (p.window.document.activeElement !== input) input.focus();
    input.value = text;
    input.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  };
  const press = (p: Panel, input: HTMLInputElement, key: string): void => {
    input.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    );
  };
  const edits = (p: Panel) => p.posted.filter((m) => m.type === 'setWarmSetting');

  it('paints every figure as a typed field, the window among them', (t) => {
    const p = openPanel(t);
    pushConfig(p, pushedConfig());
    open(p);
    const labels = ['Claude TTL', 'Codex TTL', 'Grok TTL', 'Ping buffer', 'Keep warm for'];
    const inputs = labels.map((label) => field(p, label));
    assert.deepEqual(
      inputs.map((input) => input.value),
      ['25', '30', '12', '3', '90']
    );
    for (const input of inputs) {
      assert.equal(input.type, 'text', 'a number input steps on the wheel');
      assert.equal(input.inputMode, 'numeric');
    }
    assert.equal(
      $(p, '#bottomdrawer .bddetail')?.querySelector('button:not(.why), [role="spinbutton"]'),
      null,
      'a field carries a stepper or a clear control'
    );
    assert.deepEqual(
      [...p.window.document.querySelectorAll('#bottomdrawer .ttl-field .label')].map(
        (n) => n.textContent
      ),
      labels
    );
    assert.equal(field(p, 'Ping buffer').closest('.minutes')?.textContent, '−min');
  });

  it('posts nothing while typing, and one edit on blur', (t) => {
    const p = openPanel(t);
    pushConfig(p, pushedConfig());
    open(p);
    const claude = field(p, 'Claude TTL');
    type(p, claude, '4');
    type(p, claude, '45');
    assert.deepEqual(edits(p), []);
    claude.blur();
    assert.deepEqual(edits(p), [{ type: 'setWarmSetting', key: 'ttl:claude', minutes: 45 }]);
    assert.equal(claude.value, '45');
  });

  it('clamps an out-of-range value to the bound the host pushed', (t) => {
    const p = openPanel(t);
    pushConfig(p, pushedConfig());
    open(p);
    const claude = field(p, 'Claude TTL');
    type(p, claude, '999.6');
    claude.blur();
    assert.equal(claude.value, '180');
    const buffer = field(p, 'Ping buffer');
    type(p, buffer, '0');
    buffer.blur();
    assert.equal(buffer.value, '1');
    assert.deepEqual(edits(p), [
      { type: 'setWarmSetting', key: 'ttl:claude', minutes: 180 },
      { type: 'setWarmSetting', key: 'buffer', minutes: 1 }
    ]);
  });

  it('rounds a decimal on blur', (t) => {
    const p = openPanel(t);
    pushConfig(p, pushedConfig());
    open(p);
    const window = field(p, 'Keep warm for');
    type(p, window, '45.5');
    window.blur();
    assert.equal(window.value, '46');
    assert.deepEqual(edits(p), [{ type: 'setWarmSetting', key: 'window', minutes: 46 }]);
  });

  it('commits on Enter, by leaving the field', (t) => {
    const p = openPanel(t);
    pushConfig(p, pushedConfig());
    open(p);
    const grok = field(p, 'Grok TTL');
    type(p, grok, '20');
    press(p, grok, 'Enter');
    assert.notEqual(p.window.document.activeElement, grok);
    assert.deepEqual(edits(p), [{ type: 'setWarmSetting', key: 'ttl:grok', minutes: 20 }]);
  });

  it('reverts the draft on Escape, and the sheet stays open', (t) => {
    const p = openPanel(t);
    pushConfig(p, pushedConfig());
    const sheet = open(p);
    const claude = field(p, 'Claude TTL');
    type(p, claude, '45');
    press(p, claude, 'Escape');
    assert.equal(claude.value, '25');
    assert.notEqual(p.window.document.activeElement, claude);
    assert.equal(sheet.hidden, false, 'Escape in a field closed the sheet');
    assert.deepEqual(edits(p), []);
  });

  it('leaves the value alone under the wheel, and posts nothing', (t) => {
    const p = openPanel(t);
    pushConfig(p, pushedConfig());
    open(p);
    const claude = field(p, 'Claude TTL');
    claude.focus();
    for (const deltaY of [-100, 100]) {
      claude.dispatchEvent(
        new p.window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
      );
    }
    claude.blur();
    assert.equal(claude.value, '25');
    assert.deepEqual(edits(p), []);
  });

  it('refuses a character that is not part of a number as it is typed', (t) => {
    const p = openPanel(t);
    pushConfig(p, pushedConfig());
    open(p);
    const claude = field(p, 'Claude TTL');
    type(p, claude, '4');
    type(p, claude, '4a');
    assert.equal(claude.value, '4');
    type(p, claude, '');
    claude.blur();
    assert.equal(claude.value, '25', 'an emptied field keeps its figure');
    assert.deepEqual(edits(p), []);
  });

  it('compares a commit with the last push, not the first paint', (t) => {
    const p = openPanel(t);
    pushConfig(p, configWith(60));
    open(p);
    const claude = field(p, 'Claude TTL');
    type(p, claude, '30');
    claude.blur();
    pushConfig(p, configWith(30));
    assert.equal(field(p, 'Claude TTL'), claude, 'the push replaced the field');
    type(p, claude, '60');
    claude.blur();
    assert.deepEqual(edits(p), [
      { type: 'setWarmSetting', key: 'ttl:claude', minutes: 30 },
      { type: 'setWarmSetting', key: 'ttl:claude', minutes: 60 }
    ]);
  });

  it('shows a committed value until a push agrees with it', (t) => {
    const p = openPanel(t);
    pushConfig(p, configWith(60));
    open(p);
    const claude = field(p, 'Claude TTL');
    type(p, claude, '30');
    claude.blur();
    pushConfig(p, configWith(60));
    assert.equal(claude.value, '30', 'a push composed before the write took the edit back');
    pushConfig(p, configWith(30));
    pushConfig(p, configWith(45));
    assert.equal(claude.value, '45', 'an agreeing push did not retire the edit');
  });

  it('retires a committed value on an agreeing push that lands while Warm is shut', (t) => {
    const p = openPanel(t);
    pushConfig(p, configWith(60));
    open(p);
    const claude = field(p, 'Claude TTL');
    type(p, claude, '30');
    claude.blur();
    p.window.document.getElementById('bottomdrawer-close')?.click();
    pushConfig(p, configWith(30));
    pushConfig(p, configWith(45));
    open(p);
    assert.equal(field(p, 'Claude TTL').value, '45', 'the edit outlived the push that agreed');
    assert.equal(field(p, 'Claude TTL').dataset.value, '45');
  });

  it('puts a committed value back when the host could not write it', (t) => {
    const p = openPanel(t);
    pushConfig(p, configWith(60));
    open(p);
    const claude = field(p, 'Claude TTL');
    type(p, claude, '30');
    claude.blur();
    p.push({ type: 'warmSettingChoice', key: 'ttl:claude', minutes: 30, landed: false });
    assert.equal(field(p, 'Claude TTL').value, '60', 'a refused write left the edit on screen');
  });

  it('keeps a later commit through the refusal of an earlier one', (t) => {
    const p = openPanel(t);
    pushConfig(p, configWith(60));
    open(p);
    type(p, field(p, 'Claude TTL'), '30');
    field(p, 'Claude TTL').blur();
    type(p, field(p, 'Claude TTL'), '45');
    field(p, 'Claude TTL').blur();
    p.push({ type: 'warmSettingChoice', key: 'ttl:claude', minutes: 30, landed: false });
    assert.equal(field(p, 'Claude TTL').value, '45', 'an older refusal dropped a newer commit');
  });

  it('leaves a focused draft alone through a push and the 1s repaint', async (t) => {
    const p = openPanel(t);
    const ticking = [
      card(1, warm({ on: true, nextAt: Date.now() + 60_500, endsAt: Date.now() + HOUR }))
    ];
    pushConfig(p, pushedConfig(), ticking);
    const sheet = open(p);
    const buffer = field(p, 'Ping buffer');
    type(p, buffer, '9');
    pushConfig(p, { ...pushedConfig(), buffer: { ...pushedConfig().buffer, minutes: 4 } }, ticking);
    assert.equal(buffer.value, '9', 'a push wrote over the draft');
    await new Promise((done) => setTimeout(done, 1200));
    assert.equal(clause(row(sheet, 'session 1'))?.textContent, 'ping in 59s');
    assert.equal(field(p, 'Ping buffer'), buffer);
    assert.equal(p.window.document.activeElement, buffer, 'the repaint took the focus');
    assert.equal(buffer.value, '9', 'the repaint wrote over the draft');
  });

  for (const leave of ['blur', 'Enter', 'Escape'] as const) {
    it(`takes a push it kept off a focused field once focus leaves by ${leave}`, (t) => {
      // No sessions, so no countdown moves the signature after the push.
      const withBuffer = (minutes: number): WarmConfigView => ({
        ...pushedConfig(),
        buffer: { ...pushedConfig().buffer, minutes }
      });
      const p = openPanel(t);
      pushConfig(p, withBuffer(5), []);
      open(p);
      const buffer = field(p, 'Ping buffer');
      buffer.focus();
      // Escape is the way out that drops a draft; the others would commit one.
      if (leave === 'Escape') type(p, buffer, '9');
      pushConfig(p, withBuffer(4), []);
      if (leave === 'blur') buffer.blur();
      else press(p, buffer, leave);
      assert.equal(buffer.value, '4', 'the field kept the push it skipped');
      assert.equal(buffer.dataset.value, '4', 'a commit would compare with the skipped push');
      pushConfig(p, withBuffer(4), []);
      assert.equal(buffer.value, '4');
      assert.deepEqual(edits(p), []);
      type(p, buffer, '5');
      buffer.blur();
      assert.deepEqual(edits(p), [{ type: 'setWarmSetting', key: 'buffer', minutes: 5 }]);
    });
  }

  it('repaints the column and the note on a push that changes only the config', (t) => {
    const p = openPanel(t);
    const sessions = [card(1, warm())];
    p.push(stateMessage([groupView({ sessions })]));
    open(p);
    assert.equal(field(p, 'Claude TTL').value, '60');
    pushConfig(p, pushedConfig(), sessions);
    assert.equal(field(p, 'Claude TTL').value, '25');
    assert.equal(field(p, 'Keep warm for').value, '90');
    assert.match(
      p.window.document.getElementById('bottomdrawer-note')?.textContent ?? '',
      /warm for up to 1h 30m after the last real turn/
    );
  });
});
