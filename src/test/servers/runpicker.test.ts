import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Panel, cardView, groupView, openPanel, portsMsg, stateMessage } from '../harness';

/**
 * The servers sheet: a rail of a repo's worktrees beside everything the selected
 * one can start. The rail paints from the state message and the starts from a
 * `ports` answer, so most of these push both by hand.
 */

const ROOT = '/Users/someone/proj';
const SIDE = ROOT + '/.worktrees/side';

const row = (over: Partial<ServerRowView> = {}): ServerRowView => ({
  branch: 'main',
  tree: ROOT,
  cwd: ROOT,
  runnerId: 'dev',
  label: 'npm run dev',
  ...over
});

const idleSide = row({ branch: 'side', tree: SIDE, cwd: SIDE });

const stateWith = (rows: ServerRowView[]) =>
  stateMessage([groupView({ cwd: ROOT, label: 'proj', servers: rows })]);

/** Opens the sheet by the door, the way a reader does. */
function openSheet(p: Panel, rows: ServerRowView[] = [row(), idleSide]): void {
  p.push(stateWith(rows));
  p.window.document.querySelector<HTMLElement>('.sdoor')?.click();
}

const doc = (p: Panel) => p.window.document;
const sheet = (p: Panel) => doc(p).querySelector<HTMLElement>('#runsheet');
const railRows = (p: Panel) => [...doc(p).querySelectorAll<HTMLElement>('#rbody .srail .rstart')];
const startsDrawn = (p: Panel) => [...doc(p).querySelectorAll<HTMLElement>('#rbody .sstart')];
const tiles = (p: Panel) => [...doc(p).querySelectorAll<HTMLElement>('#rbody .rtile')];
const note = (p: Panel) => doc(p).querySelector('#rbody .rnote')?.textContent ?? '';
const startNamed = (p: Panel, text: string) =>
  startsDrawn(p).find((node) => node.textContent?.includes(text));
const act = (node: HTMLElement | undefined, word: string) =>
  [...(node?.querySelectorAll<HTMLElement>('button') ?? [])].find((b) =>
    b.textContent?.startsWith(word)
  );

const answer = (over: Partial<PortsMessage> = {}): PortsMessage =>
  portsMsg({ cwd: ROOT, branch: 'main', runnerId: '', ...over });

const MONOREPO: PortsMessage['starts'] = [
  { cwd: ROOT + '/apps/web', runnerId: 'dev', label: 'apps/web · npm run dev', key: 'web' },
  { cwd: ROOT + '/apps/admin', runnerId: 'dev', label: 'apps/admin · npm run dev', key: 'admin' },
  {
    cwd: ROOT + '/apps/desktop',
    runnerId: 'host',
    label: 'apps/desktop · Extension dev host',
    key: 'desktop',
    portless: true
  }
];

const BLOCK: PortsMessage['ports'] = [
  { port: 3000, free: true },
  { port: 3001, free: true },
  { port: 3002, free: false, heldBy: 'staging-web', holder: { cwd: SIDE, runnerId: 'dev' } },
  { port: 3003, free: false }
];

describe('the rail', () => {
  it('draws every worktree from the state alone, before any answer', (t) => {
    const p = openPanel(t);
    openSheet(p);
    assert.equal(sheet(p)?.hidden, false);
    assert.deepEqual(
      railRows(p).map((node) => node.querySelector('.nm')?.textContent),
      ['main', 'side']
    );
    assert.match(note(p), /Checking which ports/);
  });

  it('puts running above idle and says so', (t) => {
    const p = openPanel(t);
    openSheet(p, [row(), row({ ...idleSide, status: 'up', port: 3001 })]);
    assert.equal(railRows(p)[0]?.querySelector('.nm')?.textContent, 'side');
    assert.deepEqual(
      [...doc(p).querySelectorAll('.srail .cap')].map((node) => node.textContent),
      ['Running', 'Idle']
    );
  });

  it('counts worktrees and servers in the head', (t) => {
    const p = openPanel(t);
    openSheet(p, [row({ status: 'up', port: 3000 }), idleSide]);
    assert.equal(doc(p).querySelector('#rhead .ttl')?.textContent, 'proj');
    assert.equal(doc(p).querySelector('#rhead .cw')?.textContent, '2 worktrees · 1 server');
  });

  it('asks the host about the worktree it opened on, with no runner', (t) => {
    const p = openPanel(t);
    openSheet(p);
    assert.deepEqual(p.posted.at(-1), {
      type: 'openRunPicker',
      cwd: ROOT,
      tree: ROOT,
      branch: 'main'
    });
  });

  it('switches worktree in place, and asks again', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer());
    railRows(p)[1]?.click();
    assert.equal(sheet(p)?.hidden, false, 'switching closed the sheet');
    assert.deepEqual(p.posted.at(-1), {
      type: 'openRunPicker',
      cwd: SIDE,
      tree: SIDE,
      branch: 'side'
    });
    assert.equal(doc(p).querySelector('.sshead b')?.textContent, 'side');
    assert.match(note(p), /Checking which ports/, 'drew the last worktree’s starts');
  });

  it('drops an answer for the worktree it has left', (t) => {
    const p = openPanel(t);
    openSheet(p);
    railRows(p)[1]?.click();
    p.push(answer());
    assert.match(note(p), /Checking which ports/);
    p.push(answer({ cwd: SIDE, branch: 'side' }));
    assert.equal(note(p), '');
  });

  it('keeps its place and its focus across a state push', (t) => {
    const p = openPanel(t);
    openSheet(p);
    railRows(p)[1]?.click();
    p.push(answer({ cwd: SIDE, branch: 'side' }));
    const run = act(startsDrawn(p)[0], 'Run');
    run?.focus();
    p.push(stateWith([row(), idleSide]));
    assert.equal(doc(p).querySelector('.sshead b')?.textContent, 'side');
    assert.equal(doc(p).activeElement, run, 'the push rebuilt what had focus');
  });

  it('opens on the selected card’s worktree, the nearest one that holds it', (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([
        groupView({
          cwd: ROOT,
          label: 'proj',
          sessions: [cardView({ pid: 9, fullCwd: SIDE + '/apps/web' })],
          servers: [row(), idleSide]
        })
      ])
    );
    doc(p).querySelector<HTMLElement>('.card')?.click();
    doc(p).querySelector<HTMLElement>('.sdoor')?.click();
    assert.equal(doc(p).querySelector('.sshead b')?.textContent, 'side');
  });

  it('shuts when the repo has gone', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(stateMessage([]));
    assert.equal(sheet(p)?.hidden, true);
  });

  it('moves to another worktree when the selected one has gone', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(stateWith([idleSide]));
    assert.equal(doc(p).querySelector('.sshead b')?.textContent, 'side');
  });
});

describe('the starts', () => {
  it('splits an app from its runner, one row per start', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer({ starts: MONOREPO, ports: BLOCK }));
    assert.equal(startsDrawn(p).length, 3);
    assert.equal(startsDrawn(p)[0]?.querySelector('.nm b')?.textContent, 'apps/web');
    assert.equal(startsDrawn(p)[0]?.querySelector('.nm i')?.textContent, 'npm run dev');
  });

  it('offers Run on the default port', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer({ lastUsed: { dev: 3001 } }));
    assert.equal(startsDrawn(p)[0]?.querySelector('.spick')?.textContent, ':3001 ▾');
    act(startsDrawn(p)[0], 'Run')?.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'run',
      cwd: ROOT,
      tree: ROOT,
      runnerId: 'dev',
      branch: 'main',
      port: 3001
    });
  });

  it('stays open after Run and will not start the same thing twice', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer());
    act(startsDrawn(p)[0], 'Run')?.click();
    assert.equal(sheet(p)?.hidden, false, 'Run closed the sheet');
    assert.equal(act(startsDrawn(p)[0], 'Run'), undefined, 'offered a second start');
    assert.ok(act(startsDrawn(p)[0], 'Starting'), 'the press said nothing');
  });

  it('runs a start that takes no port with no port', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer({ starts: MONOREPO, ports: BLOCK }));
    const desktop = startNamed(p, 'apps/desktop');
    assert.equal(desktop?.querySelector('.port')?.textContent, 'no port');
    act(desktop, 'Run')?.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'run',
      cwd: ROOT + '/apps/desktop',
      tree: ROOT,
      runnerId: 'host',
      branch: 'main'
    });
  });

  it('draws a running server with its link and Stop, and no Run', (t) => {
    const p = openPanel(t);
    openSheet(p, [row({ status: 'up', port: 3000, url: 'http://localhost:3000' })]);
    p.push(answer());
    const node = startsDrawn(p)[0];
    assert.equal(act(node, 'Run'), undefined);
    node?.querySelector<HTMLElement>('.slink')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openServer', url: 'http://localhost:3000' });
    act(node, 'Stop')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'stopRun', cwd: ROOT, runnerId: 'dev' });
  });

  it('marks a Stop on the row and on the chip, and offers no second one', (t) => {
    const p = openPanel(t);
    openSheet(p, [row({ status: 'up', port: 3000 })]);
    p.push(answer());
    act(startsDrawn(p)[0], 'Stop')?.click();
    assert.match(startsDrawn(p)[0]?.textContent ?? '', /stopping/);
    assert.equal(act(startsDrawn(p)[0], 'Stop'), undefined);
    assert.ok(doc(p).querySelector('.servers .srv.stopping'), 'the chip disagrees');
  });

  it('offers a failed server its reason, a Stop and another Run', (t) => {
    const p = openPanel(t);
    openSheet(p, [row({ status: 'failed', port: 3000, reason: 'port taken' })]);
    p.push(
      answer({
        ports: [
          { port: 3000, free: false, heldBy: 'main', holder: { cwd: ROOT, runnerId: 'dev' } },
          { port: 3001, free: true }
        ],
        lastUsed: { dev: 3000 }
      })
    );
    const node = startsDrawn(p)[0];
    assert.match(node?.textContent ?? '', /port taken/);
    assert.ok(act(node, 'Stop'));
    assert.equal(node?.querySelector('.spick')?.textContent, ':3001 ▾', 'offered the failed port');
    assert.ok(act(node, 'Run'));
  });

  it('keeps a session’s server reachable with a Stop aimed at its pid', (t) => {
    const p = openPanel(t);
    const server = row({
      runnerId: '',
      label: 'next dev',
      port: 3003,
      url: 'http://localhost:3003',
      listener: { command: 'next dev', pid: 42, startedAt: 7, session: 'Fix billing' }
    });
    openSheet(p, [server]);
    p.push(answer());
    const node = startNamed(p, 'next dev');
    act(node, 'Stop')?.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'killListener',
      port: 3003,
      pid: 42,
      startedAt: 7,
      command: 'next dev'
    });
  });

  it('opens the sheet on the worktree a failed chip belongs to', (t) => {
    const p = openPanel(t);
    p.push(
      stateWith([row(), row({ ...idleSide, status: 'failed', port: 3001, reason: 'port taken' })])
    );
    doc(p).querySelector<HTMLElement>('.srv [data-act="openServers"]')?.click();
    assert.equal(doc(p).querySelector('.sshead b')?.textContent, 'side');
  });

  it('asks again when a server takes or leaves a port', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer());
    const before = p.posted.length;
    p.push(stateWith([row(), idleSide]));
    assert.equal(p.posted.length, before, 'a quiet push cost a bind pass');
    p.push(stateWith([row({ status: 'starting', port: 3000 }), idleSide]));
    assert.deepEqual(p.posted.at(-1), {
      type: 'openRunPicker',
      cwd: ROOT,
      tree: ROOT,
      branch: 'main'
    });
    const asked = p.posted.length;
    p.push(stateWith([row({ status: 'up', port: 3000 }), idleSide]));
    assert.equal(p.posted.length, asked, 'coming up holds the same port');
  });

  it('keeps each row’s own Stop when one of two running apps goes', (t) => {
    const p = openPanel(t);
    const web = row({ cwd: MONOREPO[0]?.cwd ?? '', app: 'apps/web', status: 'up', port: 3000 });
    const admin = row({ cwd: MONOREPO[1]?.cwd ?? '', app: 'apps/admin', status: 'up', port: 3001 });
    openSheet(p, [web, admin]);
    p.push(answer({ starts: MONOREPO, ports: BLOCK }));
    p.push(stateWith([admin]));
    p.push(answer({ starts: MONOREPO, ports: BLOCK }));
    p.push(stateWith([row()]));
    p.push(answer({ starts: MONOREPO, ports: BLOCK }));
    for (const name of ['apps/web', 'apps/admin']) {
      const node = startNamed(p, name);
      assert.equal(act(node, 'Stop'), undefined, name + ' kept a Stop for nothing');
      assert.ok(act(node, 'Run'), name + ' lost its Run');
    }
  });

  it('follows a checkout that changes branch under the open sheet', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer());
    p.push(stateWith([row({ branch: 'feat' })]));
    assert.deepEqual(p.posted.at(-1), {
      type: 'openRunPicker',
      cwd: ROOT,
      tree: ROOT,
      branch: 'feat'
    });
    p.push(answer({ branch: 'feat', lastUsed: { dev: 3001 } }));
    assert.equal(startsDrawn(p)[0]?.querySelector('.spick')?.textContent, ':3001 ▾');
    act(startsDrawn(p)[0], 'Run')?.click();
    assert.equal((p.posted.at(-1) as { branch?: string }).branch, 'feat');
  });

  it('does not carry a press to the same start of another worktree', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer());
    act(startsDrawn(p)[0], 'Run')?.click();
    railRows(p)[1]?.click();
    p.push(answer({ cwd: SIDE, branch: 'side' }));
    assert.ok(act(startsDrawn(p)[0], 'Run'), 'side reads as started by main’s press');
  });

  it('says why when there is nothing to start, and names the setting', (t) => {
    const p = openPanel(t);
    openSheet(p, [row({ runnerId: '', unrunnable: true, workspaces: true })]);
    p.push(answer({ starts: [] }));
    assert.match(note(p), /declares workspaces/);
    assert.match(note(p), /squadron\.run\.commands/);
  });

  it('asks the reader to pick between two scripts', (t) => {
    const p = openPanel(t);
    openSheet(p, [row({ runnerId: '', unrunnable: true, candidates: ['dev', 'start'] })]);
    p.push(
      answer({
        starts: [
          { cwd: ROOT, runnerId: 'dev', label: 'npm run dev', key: 'dev' },
          { cwd: ROOT, runnerId: 'start', label: 'npm run start', key: 'start' }
        ]
      })
    );
    assert.match(note(p), /Pick one/);
    assert.equal(startsDrawn(p).length, 2);
  });

  it('names the block when every port in it is taken, and offers no Run', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(
      answer({
        ports: [
          { port: 3000, free: false },
          { port: 3001, free: false }
        ]
      })
    );
    assert.match(note(p), /3000 to 3001/);
    assert.equal(act(startsDrawn(p)[0], 'Run'), undefined);
  });
});

describe('a block per start', () => {
  const ASTRO = { base: 4321, span: 3 };
  const VITE = { base: 5173, span: 2 };
  const TWO: PortsMessage['starts'] = [
    {
      cwd: ROOT + '/apps/site',
      runnerId: 'dev',
      label: 'apps/site · npm run dev',
      key: 'site',
      block: ASTRO
    },
    {
      cwd: ROOT + '/apps/ui',
      runnerId: 'dev',
      label: 'apps/ui · npm run dev',
      key: 'ui',
      block: VITE
    }
  ];
  const UNION: PortsMessage['ports'] = [
    { port: 4321, free: true },
    { port: 4322, free: false },
    { port: 4323, free: true },
    { port: 5173, free: false },
    { port: 5174, free: true }
  ];
  const tileNumbers = (p: Panel) => tiles(p).map((tile) => tile.querySelector('.p')?.textContent);
  const count = (p: Panel) => doc(p).querySelector('.sports .cnt')?.textContent ?? '';
  const expand = (p: Panel, name: string) =>
    startNamed(p, name)?.querySelector<HTMLElement>('.spick')?.click();

  it('draws each start’s port row with its own tiles and its own free count', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer({ starts: TWO, ports: UNION }));
    expand(p, 'apps/site');
    assert.deepEqual(tileNumbers(p), ['4321', '4322', '4323']);
    assert.match(count(p), /2 of 3 free/);
    expand(p, 'apps/ui');
    assert.deepEqual(tileNumbers(p), ['5173', '5174']);
    assert.match(count(p), /1 of 2 free/);
  });

  it('defaults each start to the first free port of its own block', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer({ starts: TWO, ports: UNION }));
    assert.equal(startNamed(p, 'apps/site')?.querySelector('.spick')?.textContent, ':4321 ▾');
    assert.equal(startNamed(p, 'apps/ui')?.querySelector('.spick')?.textContent, ':5174 ▾');
  });

  it('draws every row for a start with no block, as an older host sent it', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer({ ports: UNION }));
    startsDrawn(p)[0]?.querySelector<HTMLElement>('.spick')?.click();
    assert.equal(tiles(p).length, 5);
  });

  it('says one start’s block is full while the other runs, and keeps the note for all-full', (t) => {
    const p = openPanel(t);
    openSheet(p);
    const full = UNION.map((row) =>
      row.port >= 5173 ? { port: row.port, free: false as const } : row
    );
    p.push(answer({ starts: TWO, ports: full }));
    const ui = startNamed(p, 'apps/ui');
    assert.equal(ui?.querySelector('.port')?.textContent, 'no free port ▾');
    assert.equal(act(ui, 'Run'), undefined);
    assert.ok(act(startNamed(p, 'apps/site'), 'Run'), 'the free block lost its Run');
    assert.equal(note(p), '');
  });

  it('names every range when no start has a free port', (t) => {
    const p = openPanel(t);
    openSheet(p);
    const full = UNION.map((row) => ({ port: row.port, free: false as const }));
    p.push(answer({ starts: TWO, ports: full }));
    assert.match(note(p), /4321 to 4323/);
    assert.match(note(p), /5173 to 5174/);
    assert.equal(act(startNamed(p, 'apps/site'), 'Run'), undefined);
  });

  it('opens a full block’s port row, so a typed port can run it', (t) => {
    const p = openPanel(t);
    openSheet(p);
    const full = UNION.map((row) => ({ port: row.port, free: false as const }));
    p.push(answer({ starts: TWO, ports: full }));
    expand(p, 'apps/site');
    const input = doc(p).querySelector<HTMLInputElement>('#rbody .sports input.rport');
    assert.ok(input, 'a full block hides the field');
    input.value = '8080';
    input.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    act(startNamed(p, 'apps/site'), 'Run')?.click();
    assert.equal((p.posted.at(-1) as { port?: number }).port, 8080);
  });

  it('drops the all-full note while a start still runs on its outside port', (t) => {
    const p = openPanel(t);
    openSheet(p);
    const full = UNION.map((row) => ({ port: row.port, free: false as const }));
    p.push(
      answer({
        starts: TWO,
        ports: [{ port: 3000, free: true }, ...full],
        lastUsed: { site: 3000 }
      })
    );
    assert.equal(note(p), '');
    assert.ok(act(startNamed(p, 'apps/site'), 'Run'), 'the outside port lost its Run');
    assert.equal(startNamed(p, 'apps/ui')?.querySelector('.port')?.textContent, 'no free port ▾');
  });
});

describe('the port row', () => {
  function openPorts(p: Panel): void {
    openSheet(p);
    p.push(answer({ starts: MONOREPO, ports: BLOCK, lastUsed: { web: 3001 } }));
    startsDrawn(p)[0]?.querySelector<HTMLElement>('.spick')?.click();
  }

  it('opens under its start, with a tile per port and the free count', (t) => {
    const p = openPanel(t);
    openPorts(p);
    assert.equal(tiles(p).length, 4);
    assert.match(doc(p).querySelector('.sports .cnt')?.textContent ?? '', /2 of 4 free/);
    assert.ok(startsDrawn(p)[0]?.classList.contains('open'));
    assert.match(tiles(p)[1]?.textContent ?? '', /last/);
  });

  it('names a held port’s holder, and only ours carries a Stop', (t) => {
    const p = openPanel(t);
    openPorts(p);
    assert.match(tiles(p)[2]?.textContent ?? '', /staging-web/);
    assert.ok(tiles(p)[2]?.querySelector('.stop'));
    assert.equal(tiles(p)[3]?.querySelector('.stop'), null);
    assert.equal(tiles(p)[2]?.getAttribute('role'), 'group');
  });

  it('moves the row’s port when a tile is armed, and keeps focus on it', (t) => {
    const p = openPanel(t);
    openPorts(p);
    const tile = tiles(p)[0];
    tile?.focus();
    tile?.click();
    assert.equal(startsDrawn(p)[0]?.querySelector('.spick')?.textContent, ':3000 ▾');
    assert.equal(act(startsDrawn(p)[0], 'Run')?.textContent, 'Run :3000');
    assert.equal(doc(p).querySelector('.rtile.on .p')?.textContent, '3000');
    assert.equal(doc(p).activeElement, tile, 'the repaint rebuilt the armed tile');
  });

  it('runs on the armed port', (t) => {
    const p = openPanel(t);
    openPorts(p);
    tiles(p)[0]?.click();
    act(startsDrawn(p)[0], 'Run')?.click();
    assert.equal((p.posted.at(-1) as { port?: number }).port, 3000);
    assert.equal(doc(p).querySelector('.sports'), null, 'the row stayed open');
  });

  it('never offers a remembered port that has been taken', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer({ ports: BLOCK, lastUsed: { dev: 3002 } }));
    assert.equal(startsDrawn(p)[0]?.querySelector('.spick')?.textContent, ':3000 ▾');
  });

  it('stops a holder from its tile and says so until the port frees', (t) => {
    const p = openPanel(t);
    openPorts(p);
    tiles(p)[2]?.querySelector<HTMLElement>('.stop')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'stopRun', cwd: SIDE, runnerId: 'dev' });
    assert.match(tiles(p)[2]?.textContent ?? '', /stopping/);
    assert.equal(doc(p).activeElement, sheet(p), 'focus fell out of the sheet');
    p.push(
      answer({
        starts: MONOREPO,
        ports: [
          { port: 3000, free: true },
          { port: 3001, free: true },
          { port: 3002, free: true },
          { port: 3003, free: false }
        ]
      })
    );
    assert.doesNotMatch(tiles(p)[2]?.textContent ?? '', /stopping/);
  });

  it('marks a tile’s Stop on the row and the chip it names', (t) => {
    const p = openPanel(t);
    const web = MONOREPO[0]?.cwd ?? '';
    const mine = row({ cwd: web, app: 'apps/web', status: 'up', port: 3002 });
    p.push(stateWith([mine]));
    p.window.document.querySelector<HTMLElement>('.sdoor')?.click();
    p.push(
      answer({
        starts: MONOREPO,
        ports: [
          { port: 3001, free: true },
          { port: 3002, free: false, heldBy: 'main', holder: { cwd: web, runnerId: 'dev' } }
        ]
      })
    );
    startNamed(p, 'apps/admin')?.querySelector<HTMLElement>('.spick')?.click();
    tiles(p)[1]?.querySelector<HTMLElement>('.stop')?.click();
    assert.ok(doc(p).querySelector('.servers .srv.stopping'), 'the chip disagrees');
    assert.match(startNamed(p, 'apps/web')?.textContent ?? '', /stopping/);
  });

  it('offers a tile’s Stop again when the wait runs out', (t) => {
    const p = openPanel(t);
    openPorts(p);
    tiles(p)[2]?.querySelector<HTMLElement>('.stop')?.click();
    const real = p.window.Date.now;
    p.window.Date.now = () => real() + 9_000;
    t.after(() => {
      p.window.Date.now = real;
    });
    p.push(answer({ starts: MONOREPO, ports: BLOCK, lastUsed: { web: 3001 } }));
    assert.ok(tiles(p)[2]?.querySelector('.stop'), 'stuck on stopping');
  });
});

describe('the outside tile', () => {
  const SITE: PortsMessage['starts'] = [
    {
      cwd: ROOT + '/apps/site',
      runnerId: 'dev',
      label: 'apps/site · npm run dev',
      key: 'site',
      block: { base: 4321, span: 2 }
    }
  ];
  const ASTRO: PortsMessage['ports'] = [
    { port: 4321, free: true },
    { port: 4322, free: true }
  ];
  const outside = (p: Panel) => doc(p).querySelector<HTMLElement>('#rbody .sports .rout .rtile');
  const openSite = (p: Panel, last: PortsMessage['ports'][number]): void => {
    openSheet(p);
    p.push(answer({ starts: SITE, ports: [last, ...ASTRO], lastUsed: { site: last.port } }));
    startsDrawn(p)[0]?.querySelector<HTMLElement>('.spick')?.click();
  };

  it('draws the port this start used last, outside the grid, and arms it', (t) => {
    const p = openPanel(t);
    openSite(p, { port: 3000, free: true });
    assert.equal(outside(p)?.querySelector('.p')?.textContent, 'last: 3000');
    assert.ok(outside(p)?.classList.contains('on'));
    assert.equal(doc(p).querySelectorAll('.rgrid .rtile').length, 2);
    assert.match(doc(p).querySelector('.sports .cnt')?.textContent ?? '', /2 of 2 free/);
    assert.equal(startsDrawn(p)[0]?.querySelector('.spick')?.textContent, ':3000 ▾');
  });

  it('names a taken one’s holder, offers its Stop, and does not arm it', (t) => {
    const p = openPanel(t);
    openSite(p, {
      port: 3000,
      free: false,
      heldBy: 'staging-web',
      holder: { cwd: SIDE, runnerId: 'dev' }
    });
    assert.match(outside(p)?.textContent ?? '', /staging-web/);
    assert.ok(outside(p)?.querySelector('.stop'));
    assert.equal(startsDrawn(p)[0]?.querySelector('.spick')?.textContent, ':4321 ▾');
  });

  it('runs on it', (t) => {
    const p = openPanel(t);
    openSite(p, { port: 3000, free: true });
    doc(p).querySelector<HTMLElement>('.rgrid .rtile')?.click();
    outside(p)?.click();
    act(startsDrawn(p)[0], 'Run')?.click();
    assert.equal((p.posted.at(-1) as { port?: number }).port, 3000);
  });

  it('draws a remembered port inside another start’s block as this start’s outside tile', (t) => {
    const p = openPanel(t);
    openSheet(p);
    const ui = {
      cwd: ROOT + '/apps/ui',
      runnerId: 'dev',
      label: 'apps/ui · npm run dev',
      key: 'ui',
      block: { base: 5173, span: 2 }
    };
    p.push(
      answer({
        starts: [...SITE, ui],
        ports: [...ASTRO, { port: 5173, free: true }, { port: 5174, free: true }],
        lastUsed: { site: 5174 }
      })
    );
    startNamed(p, 'apps/site')?.querySelector<HTMLElement>('.spick')?.click();
    assert.equal(outside(p)?.querySelector('.p')?.textContent, 'last: 5174');
  });
});

describe('a port a browser refuses', () => {
  const X11: PortsMessage['starts'] = [
    { cwd: ROOT, runnerId: 'dev', label: 'npm run dev', key: 'dev', block: { base: 5999, span: 3 } }
  ];
  const openX11 = (p: Panel, ports: PortsMessage['ports']): void => {
    openSheet(p);
    p.push(answer({ starts: X11, ports, lastUsed: { dev: 6000 } }));
    startsDrawn(p)[0]?.querySelector<HTMLElement>('.spick')?.click();
  };
  const tileOf = (p: Panel, port: number) =>
    tiles(p).find((tile) => tile.querySelector('.p')?.textContent === String(port));

  it('draws the tile unpickable, says why, and never arms it', (t) => {
    const p = openPanel(t);
    openX11(p, [
      { port: 5999, free: true },
      { port: 6000, free: true },
      { port: 6001, free: true }
    ]);
    const x11 = tileOf(p, 6000);
    assert.equal(x11?.tagName, 'DIV');
    assert.equal(x11?.getAttribute('role'), 'group');
    assert.equal(x11?.getAttribute('aria-label'), '6000 — browsers refuse it');
    assert.equal(doc(p).querySelector('.rtile.on .p')?.textContent, '5999');
    assert.match(doc(p).querySelector('.sports .cnt')?.textContent ?? '', /2 of 3 free/);
  });

  it('starts nothing on Enter at the refused tile', (t) => {
    const p = openPanel(t);
    openX11(p, [
      { port: 5999, free: true },
      { port: 6000, free: true },
      { port: 6001, free: true }
    ]);
    const before = p.posted.length;
    tileOf(p, 6000)?.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    assert.equal(p.posted.length, before);
  });

  it('counts a block whose only free port is refused as full', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(
      answer({
        starts: X11,
        ports: [
          { port: 5999, free: false },
          { port: 6000, free: true },
          { port: 6001, free: false }
        ]
      })
    );
    assert.match(note(p), /5999 to 6001/);
    assert.equal(act(startsDrawn(p)[0], 'Run'), undefined);
  });
});

describe('the typed port', () => {
  const field = (p: Panel) => doc(p).querySelector<HTMLInputElement>('#rbody .sports input.rport');
  const why = (p: Panel) => doc(p).querySelector('#rbody .sports .rwhy')?.textContent ?? '';
  const type = (p: Panel, text: string): void => {
    const input = field(p);
    if (!input) return;
    input.value = text;
    input.dispatchEvent(new p.window.Event('input', { bubbles: true }));
  };
  const runOf = (p: Panel) => act(startsDrawn(p)[0], 'Run');
  function openPorts(p: Panel): void {
    openSheet(p);
    p.push(answer({ ports: BLOCK }));
    startsDrawn(p)[0]?.querySelector<HTMLElement>('.spick')?.click();
  }

  it('is a text field for digits, with no stepper', (t) => {
    const p = openPanel(t);
    openPorts(p);
    assert.equal(field(p)?.type, 'text');
    assert.equal(field(p)?.inputMode, 'numeric');
  });

  it('arms what is typed, disarms the grid, and runs on it', (t) => {
    const p = openPanel(t);
    openPorts(p);
    type(p, '8080');
    assert.equal(doc(p).querySelector('.rtile.on'), null);
    assert.equal(runOf(p)?.textContent, 'Run :8080');
    runOf(p)?.click();
    assert.equal((p.posted.at(-1) as { port?: number }).port, 8080);
  });

  it('refuses a port a browser will not open, says why, and disables Run', (t) => {
    const p = openPanel(t);
    openPorts(p);
    type(p, '6000');
    assert.equal(why(p), 'browsers refuse it');
    assert.equal(runOf(p)?.hasAttribute('disabled'), true);
  });

  it('refuses a port the sheet already shows taken, naming its holder', (t) => {
    const p = openPanel(t);
    openPorts(p);
    type(p, '3002');
    assert.equal(why(p), 'held by staging-web');
    assert.equal(runOf(p)?.hasAttribute('disabled'), true);
    type(p, '3003');
    assert.equal(why(p), 'in use');
  });

  it('refuses what is not a port', (t) => {
    const p = openPanel(t);
    openPorts(p);
    type(p, '70000');
    assert.equal(why(p), 'not a port number');
    type(p, '12a');
    assert.equal(why(p), 'not a port number');
    assert.equal(runOf(p)?.hasAttribute('disabled'), true);
  });

  it('posts nothing on Enter while refused', (t) => {
    const p = openPanel(t);
    openPorts(p);
    type(p, '6000');
    const before = p.posted.length;
    field(p)?.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(p.posted.length, before);
  });

  it('hands the grid back when cleared', (t) => {
    const p = openPanel(t);
    openPorts(p);
    tiles(p)[1]?.click();
    type(p, '8080');
    type(p, '');
    assert.equal(doc(p).querySelector('.rtile.on .p')?.textContent, '3001');
    assert.equal(why(p), '');
  });

  it('keeps what was typed across a state push', (t) => {
    const p = openPanel(t);
    openPorts(p);
    type(p, '8080');
    p.push(stateWith([row(), idleSide]));
    assert.equal(field(p)?.value, '8080');
    assert.equal(runOf(p)?.textContent, 'Run :8080');
  });
});

describe('the sheet from the keyboard', () => {
  const press = (p: Panel, key: string): void => {
    sheet(p)?.dispatchEvent(new p.window.KeyboardEvent('keydown', { key, bubbles: true }));
  };

  it('takes Escape while the bind tests are still running', (t) => {
    const p = openPanel(t);
    openSheet(p);
    assert.equal(doc(p).activeElement, sheet(p));
    press(p, 'Escape');
    assert.equal(sheet(p)?.hidden, true);
  });

  it('runs the open row on Enter', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer());
    startsDrawn(p)[0]?.querySelector<HTMLElement>('.spick')?.click();
    press(p, 'Enter');
    assert.equal((p.posted.at(-1) as { type: string }).type, 'run');
  });

  it('will not start a row twice by Enter', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer());
    startsDrawn(p)[0]?.querySelector<HTMLElement>('.spick')?.click();
    press(p, 'Enter');
    const after = p.posted.length;
    press(p, 'Enter');
    assert.equal(p.posted.length, after);
  });

  it('keeps Escape reachable after Run and after Stop replace what was pressed', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer());
    const run = act(startsDrawn(p)[0], 'Run');
    run?.focus();
    run?.click();
    assert.equal(doc(p).activeElement, sheet(p), 'Run dropped focus out of the sheet');

    p.push(stateWith([row({ status: 'up', port: 3000 }), idleSide]));
    const stop = act(startsDrawn(p)[0], 'Stop');
    stop?.focus();
    stop?.click();
    assert.equal(doc(p).activeElement, sheet(p), 'Stop dropped focus out of the sheet');
  });

  it('hands focus back to the door on close', (t) => {
    const p = openPanel(t);
    openSheet(p);
    press(p, 'Escape');
    assert.equal(doc(p).activeElement, doc(p).querySelector('.sdoor'));
  });

  it('does nothing on Enter with no row open', (t) => {
    const p = openPanel(t);
    openSheet(p);
    p.push(answer());
    const before = p.posted.length;
    press(p, 'Enter');
    assert.equal(p.posted.length, before);
  });
});
