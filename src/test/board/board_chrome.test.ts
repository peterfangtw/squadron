import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertedMessageBody,
  Panel,
  cardView,
  groupView,
  openPanel,
  stateMessage,
  workflowView
} from '../harness';
import { css as shellCss } from '../../ui/css/shell';
import { css as ticketsCss } from '../../ui/css/tickets';

describe('startup before host data arrives', () => {
  it('initializes both Keep-awake columns when the first snapshot arrives', (t) => {
    const p = openPanel(t);
    const d = p.window.document;
    d.querySelector<HTMLButtonElement>('#bottomhub [data-drawer-mode="awake"]')?.click();
    assert.equal(d.getElementById('bottomdrawer')?.hidden, false);
    assert.match(d.querySelector('#bottomdrawer-body .bdlist')?.textContent ?? '', /Loading/);
    p.push(stateMessage([]));
    assert.equal(d.getElementById('bottomdrawer')?.hidden, false);
    assert.match(
      d.querySelector('#bottomdrawer-body .bddetail')?.textContent ?? '',
      /Configuration/
    );
    assert.ok(d.querySelector('#bottomdrawer-body .bdlist [role="switch"]'));
  });

  it('mounts current chrome with local loading states instead of empty results', (t) => {
    const p = openPanel(t);
    const d = p.window.document;
    assert.equal(d.getElementById('nav')?.hidden, false);
    assert.ok(d.querySelector('#nav #board-sessions'));
    assert.ok(d.querySelector('#nav #board-tickets'));
    assert.ok(d.querySelector('#nav .gear'));
    assert.ok(d.querySelector('#sessions-head #status-filter'));
    assert.equal(d.querySelector('#status-filter .tot')?.textContent, '…');
    assert.equal(d.getElementById('cards')?.getAttribute('aria-busy'), 'true');
    assert.match(d.getElementById('cards')?.textContent ?? '', /Loading sessions/);
    assert.ok(d.querySelector('#bottomhub [data-drawer-mode="workflows"]'));
    assert.equal(d.querySelector('#bottomhub .warm-tab .num')?.textContent, '…');
    assert.equal(d.getElementById('chat')?.getAttribute('aria-busy'), 'true');
    assert.match(d.getElementById('thread')?.textContent ?? '', /Loading/);
    assert.equal(d.querySelector<HTMLButtonElement>('#send')?.disabled, true);
    assert.deepEqual(p.onLoad, [{ type: 'ready' }]);

    const nav = d.getElementById('nav');
    p.push(stateMessage([groupView({ sessions: [cardView({ name: 'Real task' })] })]));
    assert.equal(d.getElementById('nav'), nav);
    assert.equal(d.getElementById('cards')?.getAttribute('aria-busy'), 'false');
    assert.equal(d.querySelector('#status-filter .tot')?.textContent, '1');
    assert.equal(d.querySelector('.card .name')?.textContent, 'Real task');
    assert.equal(d.getElementById('chat')?.getAttribute('aria-busy'), 'false');
  });

  it('keeps early navigation local and fills pending destinations on the first push', (t) => {
    const p = openPanel(t);
    const d = p.window.document;
    d.querySelector<HTMLButtonElement>('#board-tickets')?.click();
    assert.equal(d.getElementById('tk-list')?.hidden, false);
    assert.match(d.getElementById('tk-list')?.textContent ?? '', /Loading/);
    assert.equal(d.querySelector('.tkconnect'), null);
    d.querySelector<HTMLButtonElement>('#nav .gear')?.click();
    assert.equal(d.querySelector<HTMLDialogElement>('#settings')?.open, true);
    assert.match(d.getElementById('settings-general')?.textContent ?? '', /Loading/);
    assert.equal(d.querySelector('#settings-general input'), null);
    d.querySelector<HTMLButtonElement>('.settings-close')?.click();
    d.querySelector<HTMLButtonElement>('#bottomhub [data-drawer-mode="remote"]')?.click();
    assert.equal(d.getElementById('bottomdrawer')?.hidden, false);
    assert.match(d.querySelector('#bottomdrawer-body .bdlist')?.textContent ?? '', /Loading/);
    assert.doesNotMatch(d.getElementById('bottomdrawer-body')?.textContent ?? '', /not available/);

    p.push(stateMessage([]));
    assert.match(d.getElementById('tk-list')?.textContent ?? '', /Connect Linear/);
    assert.doesNotMatch(d.getElementById('bottomdrawer-body')?.textContent ?? '', /Loading/);
    d.querySelector<HTMLButtonElement>('#nav .gear')?.click();
    assert.doesNotMatch(d.getElementById('settings-general')?.textContent ?? '', /Loading/);
    d.querySelector<HTMLButtonElement>('.settings-close')?.click();
    d.querySelector<HTMLButtonElement>('#board-sessions')?.click();
    assert.equal(d.getElementById('cards')?.textContent, 'No sessions running.');
    assert.equal(d.querySelector('#status-filter .tot')?.textContent, '0');
    assert.equal(d.getElementById('cards')?.getAttribute('aria-busy'), 'false');
  });
});

describe('the board frame', () => {
  const ids = (n: Element | null | undefined) => [...(n?.children ?? [])].map((c) => c.id);
  const shown = (p: Panel, id: string) => {
    const n = p.window.document.getElementById(id);
    return !!n && !n.hidden && p.window.getComputedStyle(n).display !== 'none';
  };

  it('is one filter head over one body, each holding every view', (t) => {
    const p = openPanel(t);
    const d = p.window.document;
    assert.deepEqual(ids(d.getElementById('board')).slice(0, 3), [
      'nav',
      'board-head',
      'board-body'
    ]);
    assert.deepEqual(ids(d.getElementById('board-head')), ['sessions-head', 'tk-head']);
    assert.deepEqual(ids(d.getElementById('board-body')), ['cards', 'tk-list', 'alert']);
  });

  it('shows only the picked view in the head and the body', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    const d = p.window.document;
    const views = () =>
      ['sessions-head', 'cards', 'tk-head', 'tk-list'].filter((id) => shown(p, id));
    assert.deepEqual(views(), ['sessions-head', 'cards']);
    d.querySelector<HTMLElement>('#nav [data-act="tickets"]')?.click();
    assert.deepEqual(views(), ['tk-head', 'tk-list']);
    d.querySelector<HTMLElement>('#nav [data-act="sessions"]')?.click();
    assert.deepEqual(views(), ['sessions-head', 'cards']);
  });

  // jsdom resolves no var(), so the rule text: the scrollers' top padding and
  // the waiting bar's offset are one figure, declared once on the body.
  it('starts the waiting bar where the body content starts', () => {
    const rule = (css: string, selector: string): string => {
      const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const at = clean.indexOf(`${selector} {`);
      return at < 0 ? '' : clean.slice(at, clean.indexOf('}', at) + 1);
    };
    const body = rule(shellCss, '#board-body');
    assert.match(body, /position:\s*relative/);
    assert.match(body, /--body-pad:\s*\d+px/);
    assert.match(
      rule(shellCss, '#board-body > :not(#alert)'),
      /padding-block:\s*var\(--body-pad\) /
    );
    const alert = rule(ticketsCss, '#alert');
    assert.match(alert, /top:\s*var\(--body-pad\);/);
  });
});

describe('the alert bar', () => {
  const waiting = (pid: number, over = {}) =>
    cardView({ pid, name: 'w' + pid, status: 'waiting', ...over });

  // The element outlives the paint now that it is the board's own box rather
  // than one of #cards' children, so "not there" is the hidden attribute and an
  // empty box — a bar left drawn with stale chips would name sessions that are
  // no longer blocked, over a board that is.
  it('is put away while nothing waits', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ status: 'busy' })] })]));
    const alert = p.window.document.getElementById('alert');
    assert.ok(alert);
    assert.strictEqual(alert.hidden, true);
    assert.strictEqual(alert.querySelector('.schip'), null);
  });

  it('goes away again when the last block is answered', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [waiting(1)] })]));
    assert.equal(p.window.document.getElementById('alert')?.hidden, false);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 1, status: 'busy' })] })]));
    const alert = p.window.document.getElementById('alert');
    assert.ok(alert);
    assert.strictEqual(alert.hidden, true);
    assert.strictEqual(alert.querySelector('.schip'), null);
  });

  it('counts the waiting sessions and names each as a chip', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ sessions: [waiting(1, { waitingFor: 'permission' }), cardView({ pid: 3 })] }),
        groupView({ cwd: '/e', sessions: [waiting(2, { needs: 'a decision' })] })
      ])
    );
    const alert = p.window.document.getElementById('alert');
    assert.equal(alert?.querySelector('.lead')?.textContent, '2 waiting');
    const chips = alert?.querySelectorAll('.schip') ?? [];
    assert.equal(chips.length, 2);
    assert.equal(chips[0]?.textContent, 'w1 · permission');
    assert.equal(chips[1]?.textContent, 'w2 · a decision');
  });

  it('selects the session a chip names', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [waiting(9)] })]));
    p.window.document.querySelector<HTMLElement>('.schip')?.click();
    assert.deepEqual(p.posted.map(assertedMessageBody), [{ type: 'select', pid: 9 }]);
    assert.ok(!p.window.document.body.classList.contains('closed'), 'dock did not open');
  });

  it('caps the chips at eight until "+N more" is clicked', (t) => {
    const p = openPanel(t);
    const sessions = Array.from({ length: 10 }, (_, i) => waiting(i + 1));
    p.push(stateMessage([groupView({ sessions })]));
    const alert = p.window.document.getElementById('alert');
    assert.equal(alert?.querySelectorAll('.schip:not(.more)').length, 8);
    const more = alert?.querySelector<HTMLElement>('.schip.more');
    assert.equal(more?.textContent, '+2 more');
    more?.click();
    assert.equal(p.window.document.querySelectorAll('.schip:not(.more)').length, 10);
    // Expanded, "+N more" is spent and its slot carries the way back instead.
    // The bar floats now: without this, an expanded one is up to 40vh of the
    // board covered until the sessions themselves unblock.
    assert.equal(p.window.document.querySelector('.schip.more')?.textContent, '\u2212 less');
  });

  it('collapses again on "less", and keeps the cap after', (t) => {
    const p = openPanel(t);
    const sessions = Array.from({ length: 10 }, (_, i) => waiting(i + 1));
    p.push(stateMessage([groupView({ sessions })]));
    p.window.document.querySelector<HTMLElement>('.schip.more')?.click();
    assert.equal(p.window.document.querySelectorAll('.schip:not(.more)').length, 10);
    p.window.document.querySelector<HTMLElement>('.schip.more')?.click();
    assert.equal(p.window.document.querySelectorAll('.schip:not(.more)').length, 8);
    assert.equal(p.window.document.querySelector('.schip.more')?.textContent, '+2 more');
  });

  // The editor owns the board column whole, so a float over it would be a bar
  // over cards that are not drawn. It is the one hide path that is not "nothing
  // is blocked", and the bar is no longer a row of the list the editor empties.
  it('is put away while the board editor is open, blocked sessions or not', (t) => {
    const p = openPanel(t);
    const sessions = [waiting(1), waiting(2)];
    const workflows = [workflowView()];
    p.push(stateMessage([groupView({ sessions })], { workflows }));
    assert.equal(p.window.document.getElementById('alert')?.hidden, false);
    p.window.document.querySelector<HTMLElement>('#bottomhub .wmore')?.click();
    p.window.document.querySelector<HTMLElement>('#bottomdrawer-body .wsrow .act.edit')?.click();
    assert.equal(p.window.document.getElementById('wfeditor')?.hidden, false);
    p.push(stateMessage([groupView({ sessions })], { workflows }));
    const alert = p.window.document.getElementById('alert');
    assert.ok(alert);
    assert.strictEqual(alert.hidden, true);
    assert.strictEqual(alert.querySelector('.schip'), null);
  });
});

describe('a repo section', () => {
  const repos = (p: Panel): HTMLElement[] => [
    ...p.window.document.querySelectorAll<HTMLElement>('#cards > .repo')
  ];

  it('holds a group’s heading, servers line and grid as one node', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          label: '~/one',
          cwd: '/Users/someone/one',
          sessions: [cardView({ pid: 1, name: 'alpha' })],
          servers: [
            {
              branch: 'main',
              tree: '/Users/someone/one',
              cwd: '/Users/someone/one',
              runnerId: 'dev',
              label: 'npm run dev',
              status: 'up',
              port: 3000
            }
          ]
        })
      ])
    );
    const [repo] = repos(p);
    assert.ok(repo, 'no section around the group');
    assert.equal(repo.dataset.key, 'repo:/Users/someone/one');
    assert.deepEqual(
      [...repo.children].map((n) => n.tagName.toLowerCase() + '.' + n.className.split(' ')[0]),
      ['h2.', 'div.servers', 'div.grid']
    );
    // Nothing of the group is left outside it — that is the whole change.
    assert.equal(p.window.document.querySelectorAll('#cards > h2').length, 0);
    assert.equal(p.window.document.querySelectorAll('#cards > .grid[data-cwd]').length, 0);
  });

  it('gives every group its own section, keyed by its cwd', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ label: '~/one', cwd: '/Users/someone/one', sessions: [cardView({ pid: 1 })] }),
        groupView({ label: '~/two', cwd: '/Users/someone/two', sessions: [cardView({ pid: 2 })] })
      ])
    );
    assert.deepEqual(
      repos(p).map((r) => r.dataset.key),
      ['repo:/Users/someone/one', 'repo:/Users/someone/two']
    );
    // A card belongs to exactly one of them, and no section reaches another's.
    for (const r of repos(p)) {
      const cwd = r.querySelector<HTMLElement>('.grid[data-cwd]')?.dataset.cwd;
      assert.equal('repo:' + cwd, r.dataset.key);
    }
  });

  it('survives a repaint rather than being rebuilt', (t) => {
    const p = openPanel(t);
    const push = (): void => {
      p.push(stateMessage([groupView({ sessions: [cardView({ pid: 1, name: 'alpha' })] })]));
    };
    push();
    const first = repos(p)[0];
    push();
    assert.equal(repos(p)[0], first, 'the section was replaced by a paint');
  });
});

/**
 * The guard a morphed board needs and a rebuilt one never did: a card node that
 * outlives a paint must still act on the session it currently draws.
 *
 * Under a full rebuild this is free — node and handler are both new every
 * paint, so they cannot disagree. Under a keyed morph the node outlives the
 * `CardView` it was built from, and a handler closed over that view would post
 * against a session the card no longer names. Silent and intermittent, so it is
 * written down before the refactor rather than after it.
 */

describe('the board’s ruler', () => {
  const ruler = (p: Panel): HTMLElement | null =>
    p.window.document.querySelector<HTMLElement>('#cards .grid.ruler');

  it('ends the board with an empty grid to measure the column count off', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ name: 'alpha' })] })]));
    const r = ruler(p);
    assert.ok(r, 'no ruler on the board');
    // Empty is the whole point: an item spanning past the explicit tracks makes
    // the grid invent an implicit column, and `gridTemplateColumns` reports the
    // used list — so a grid with anything in it can report its own deformation
    // back as the count that caused it.
    assert.equal(r.childElementCount, 0);
    assert.equal(r.dataset.key, 'ruler');
    // A direct child of #cards, so it is exactly as wide as the grids whose
    // count it stands for.
    assert.equal(r.parentElement?.id, 'cards');
  });

  it('is not one of the grids the cards are drawn in', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({ label: '~/one', sessions: [cardView({ pid: 1, name: 'alpha' })] }),
        groupView({ label: '~/two', cwd: '/Users/someone/two', sessions: [cardView({ pid: 2 })] })
      ])
    );
    const grids = [
      ...p.window.document.querySelectorAll('#cards > .repo > .grid, #cards > .grid.ruler')
    ];
    const r = ruler(p);
    assert.equal(grids.length, 3, 'two group grids and the ruler');
    assert.ok(
      grids.filter((g) => g !== r).every((g) => g.querySelector('.card')),
      'a group grid drew no cards'
    );
  });

  it('stays empty with a family box on the board', (t) => {
    // The case the ruler exists for. The box spans `min(members, cols)` columns
    // of the grid it is in; the ruler is a different grid, and nothing is ever
    // put in it, so no span can reach it.
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          sessions: [
            cardView({ pid: 3, name: 'boss', children: [7, 8] }),
            cardView({ pid: 7, name: 'peer7', parent: 3 }),
            cardView({ pid: 8, name: 'peer8', parent: 3 })
          ],
          families: [{ parent: 3, members: [3, 7, 8] }]
        })
      ])
    );
    assert.ok(p.window.document.querySelector('.fam'), 'no family box to guard against');
    assert.equal(ruler(p)?.childElementCount, 0);
  });

  it('survives a repaint rather than being rebuilt under the observer', (t) => {
    // `measureColumns` runs from a ResizeObserver on #cards and repaints on a
    // change; a ruler replaced on every paint would be a fresh element each
    // time the observer went to read one.
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ name: 'alpha' })] })]));
    const first = ruler(p);
    p.push(stateMessage([groupView({ sessions: [cardView({ name: 'alpha', status: 'busy' })] })]));
    assert.equal(ruler(p), first, 'the ruler was rebuilt');
  });

  it('goes away with the cards when nothing is running', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([]));
    assert.equal(ruler(p), null);
  });
});
