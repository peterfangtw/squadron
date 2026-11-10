import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Panel, cardView, groupView, openPanel, stateMessage } from '../harness';

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
    assert.match(d.getElementById('tk-list')?.textContent ?? '', /Connect a ticket source/);
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
    assert.deepEqual(ids(d.getElementById('board-body')), ['cards', 'tk-list']);
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
