import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Panel, groupView, openPanel, stateMessage } from '../harness';

describe('the servers section', () => {
  const row = (over: Partial<ServerRowView> = {}): ServerRowView => ({
    branch: 'main',
    tree: '/Users/someone/proj',
    cwd: '/Users/someone/proj',
    runnerId: 'dev',
    label: 'npm run dev',
    ...over
  });

  const withRows = (p: Panel, rows: ServerRowView[]): void =>
    p.push(stateMessage([groupView({ servers: rows })]));

  it('renders the section between a group’s heading and its grid', (t) => {
    const p = openPanel(t);
    withRows(p, [row({ status: 'up', port: 3000 })]);
    // Inside the group's own section now, not among `#cards`' children.
    const nodes = [...(p.window.document.querySelector('#cards > .repo')?.children ?? [])];
    const heading = nodes.findIndex((n) => n.tagName === 'H2');
    const section = nodes.findIndex((n) => n.classList.contains('servers'));
    const grid = nodes.findIndex(
      (n) => n.classList.contains('grid') && !n.classList.contains('ruler')
    );
    assert.ok(section > heading, 'section is not under the heading');
    assert.ok(grid > section, 'section is not above the grid');
  });

  it('draws every live server on one line, and no idle worktree', (t) => {
    const p = openPanel(t);
    withRows(p, [
      row({ status: 'up', port: 3000 }),
      row({ branch: 'side', tree: '/t/side', cwd: '/t/side', status: 'starting', port: 3001 }),
      row({ branch: 'third', tree: '/t/third', cwd: '/t/third' })
    ]);
    const section = p.window.document.querySelector('.servers');
    assert.equal(section?.children.length, 2, 'a chip costs one node, and idle costs none');
    assert.equal(section?.querySelectorAll(':scope > .srv').length, 2);
  });

  it('draws no section for a group with nothing to start', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ servers: [] })]));
    assert.equal(p.window.document.querySelector('.servers'), null);
    assert.equal(p.window.document.querySelector('.sdoor'), null);
  });

  it('draws no line for a repo with nothing running, and keeps the door', (t) => {
    const p = openPanel(t);
    withRows(p, [row(), row({ branch: 'side', tree: '/t/side', cwd: '/t/side' })]);
    assert.equal(p.window.document.querySelector('.servers'), null);
    const door = p.window.document.querySelector('h2 .sdoor');
    assert.match(door?.textContent ?? '', /Servers/);
    assert.match(door?.textContent ?? '', /2 worktrees/);
  });

  it('counts one worktree in the singular', (t) => {
    const p = openPanel(t);
    withRows(p, [row()]);
    assert.match(p.window.document.querySelector('.sdoor')?.textContent ?? '', /1 worktree\b/);
  });

  it('counts a worktree once however many apps it runs', (t) => {
    const p = openPanel(t);
    withRows(p, [
      row({ cwd: '/Users/someone/proj/apps/web', app: 'apps/web', status: 'up', port: 3000 }),
      row({ cwd: '/Users/someone/proj/apps/admin', app: 'apps/admin', status: 'up', port: 3001 })
    ]);
    assert.match(p.window.document.querySelector('.sdoor')?.textContent ?? '', /1 worktree\b/);
  });

  it('shows a running server as a chip carrying its port', (t) => {
    const p = openPanel(t);
    withRows(p, [row({ status: 'up', port: 3000, url: 'http://localhost:3000' })]);
    const node = p.window.document.querySelector('.srv');
    assert.ok(node?.querySelector('.dot.up'), 'no running dot');
    assert.equal(node?.querySelector('.p')?.textContent, ':3000');
    // The whole chip is the link. The URL itself is in the tip, which is where
    // everything the line has no room for lives.
    assert.equal(node?.querySelector('.cbody')?.getAttribute('data-act'), 'openServer');
  });

  it('says why a start failed, and opens the sheet on its worktree', (t) => {
    const p = openPanel(t);
    withRows(p, [row({ status: 'failed', reason: 'port taken' })]);
    const node = p.window.document.querySelector('.srv');
    assert.match(node?.textContent ?? '', /port taken/);
    // The ✕ is still owed for the terminal the failed command sits in.
    assert.equal(node?.querySelector('.cbody')?.getAttribute('data-act'), 'openServers');
    assert.equal(node?.querySelector('.x')?.getAttribute('data-act'), 'stopServer');
    p.window.document.querySelector<HTMLElement>('.srv .cbody')?.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'openRunPicker',
      cwd: '/Users/someone/proj',
      tree: '/Users/someone/proj',
      branch: 'main'
    });
  });

  it('gives a stop that nobody answers back to the reader', (t) => {
    const p = openPanel(t);
    const live = row({ status: 'up', port: 3000 });
    withRows(p, [live]);
    p.window.document.querySelector<HTMLElement>('.srv .x')?.click();
    assert.ok(p.window.document.querySelector('.srv.stopping'), 'the click said nothing');
    // Nothing came back and nothing will: the window holding the terminal was
    // busy, not gone, so no status changes anywhere. The chip has to stop
    // waiting on its own, or it is inert for the rest of the session — there is
    // no ✕ on a chip that is stopping, and no second chance to press it.
    // The bundle runs in the jsdom realm, so its clock is the one to move.
    const real = p.window.Date.now;
    p.window.Date.now = () => real() + 9_000;
    t.after(() => {
      p.window.Date.now = real;
    });
    withRows(p, [live]);
    assert.equal(p.window.document.querySelector('.srv.stopping'), null, 'stuck on stopping');
    assert.ok(p.window.document.querySelector('.srv .x'), 'no way to try again');
  });

  it('names the act on the body, which its own words do not', (t) => {
    const p = openPanel(t);
    withRows(p, [row({ status: 'up', port: 3004, url: 'http://localhost:3004' })]);
    // "main :3004" names the subject; the button has to name the verb.
    const body = p.window.document.querySelector('.srv .cbody');
    assert.match(body?.getAttribute('aria-label') ?? '', /^Open http/);
  });

  it('shows a port-less runner’s label where the port would be', (t) => {
    const p = openPanel(t);
    withRows(p, [row({ label: 'Extension dev host', portless: true, status: 'up' })]);
    const node = p.window.document.querySelector('.srv');
    assert.equal(node?.querySelector('.p'), null, 'a runner with no port drew one');
    assert.match(node?.querySelector('.s')?.textContent ?? '', /dev host/i);
  });

  it('says stopping until the row itself changes', (t) => {
    const p = openPanel(t);
    const live = row({ status: 'up', port: 3000 });
    withRows(p, [live]);
    p.window.document.querySelector<HTMLElement>('.srv .x')?.click();
    assert.ok(p.window.document.querySelector('.srv.stopping'), 'the click said nothing');
    // The host has not answered yet, and the 3s repaint must not undo the
    // answer the pointer already gave.
    withRows(p, [live]);
    assert.ok(p.window.document.querySelector('.srv.stopping'), 'the repaint forgot');
    // Stopped: the status changed, so the optimistic mark goes with it.
    withRows(p, [row({ remembered: 3000 })]);
    assert.equal(p.window.document.querySelector('.srv.stopping'), null, 'stuck on stopping');
  });

  it('opens a running server’s URL', (t) => {
    const p = openPanel(t);
    withRows(p, [row({ status: 'up', port: 3000, url: 'http://localhost:3000' })]);
    p.window.document.querySelector<HTMLElement>('.srv [data-act="openServer"]')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openServer', url: 'http://localhost:3000' });
  });

  it('stops a running server', (t) => {
    const p = openPanel(t);
    withRows(p, [row({ status: 'up', port: 3000 })]);
    p.window.document.querySelector<HTMLElement>('.srv .x')?.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'stopRun',
      cwd: '/Users/someone/proj',
      runnerId: 'dev'
    });
  });

  describe('a chip for a server a session is running', () => {
    const alien = (over: Partial<ServerRowView> = {}): ServerRowView =>
      row({
        port: 3000,
        url: 'http://localhost:3000',
        listener: { command: 'node', pid: 4242, startedAt: 1234, session: 'Fix login' },
        ...over
      });

    it('draws the port as observed, not ours', (t) => {
      const p = openPanel(t);
      withRows(p, [alien()]);
      const node = p.window.document.querySelector('.srv');
      const port = node?.querySelector('.p');
      assert.equal(port?.textContent, ':3000');
      assert.ok(port?.classList.contains('alien'), 'drawn as one of ours');
    });

    it('does not read as stopped around a port that is live', (t) => {
      const p = openPanel(t);
      withRows(p, [alien()]);
      const node = p.window.document.querySelector('.srv');
      // `.srv off` tints the whole chip, the dot included. A live port inside a
      // dead-looking chip is the chip contradicting itself.
      assert.ok(node?.classList.contains('alien'), 'no mark on the chip itself');
      assert.ok(node?.querySelector('.dot.alien'), 'no mark on the dot');
    });

    it('spends its word on what is running', (t) => {
      const p = openPanel(t);
      withRows(p, [alien()]);
      assert.match(p.window.document.querySelector('.srv')?.textContent ?? '', /node/);
    });

    it('names the session where the OS reading gave no command', (t) => {
      const p = openPanel(t);
      withRows(p, [
        alien({ listener: { command: '', pid: 4242, startedAt: 1234, session: 'Fix login' } })
      ]);
      assert.match(p.window.document.querySelector('.srv')?.textContent ?? '', /Fix login/);
    });

    it('offers a stop aimed at the process, since the pid is what we hold', (t) => {
      const p = openPanel(t);
      withRows(p, [alien()]);
      const x = p.window.document.querySelector('.srv .x');
      assert.equal(x?.getAttribute('data-act'), 'killListener');
      // Both halves of the check travel with the press: the host reads the port
      // again and refuses if the pid or the command moved.
      assert.equal(x?.getAttribute('data-port'), '3000');
      assert.equal(x?.getAttribute('data-pid'), '4242');
      assert.equal(x?.getAttribute('data-started-at'), '1234');
      assert.equal(x?.getAttribute('data-command'), 'node');
      // A glyph is not a name, and "stop main" would not say what is about to
      // be signalled — this one is not a server with a terminal to close.
      assert.match(x?.getAttribute('aria-label') ?? '', /node/);
      assert.match(x?.getAttribute('aria-label') ?? '', /4242/);
    });

    it('posts the start the host checks the process by', (t) => {
      const p = openPanel(t);
      withRows(p, [alien()]);
      p.window.document.querySelector<HTMLElement>('.srv .x')?.click();
      assert.deepEqual(p.posted.at(-1), {
        type: 'killListener',
        port: 3000,
        pid: 4242,
        startedAt: 1234,
        command: 'node'
      });
    });

    it('says stopping on the press, before the host has answered', (t) => {
      const p = openPanel(t);
      withRows(p, [alien()]);
      p.window.document.querySelector<HTMLElement>('.srv .x')?.click();
      withRows(p, [alien()]);
      assert.ok(p.window.document.querySelector('.srv.stopping'), 'lost the press');
      // The node stays for the length of its own exit and is a span while it
      // does, so what has to be gone is the act and not the ✕.
      assert.equal(p.window.document.querySelector('.srv .x[data-act]'), null, 'a second signal');
    });

    it('stops saying stopping when the listener it named is gone', (t) => {
      const p = openPanel(t);
      withRows(p, [alien()]);
      p.window.document.querySelector<HTMLElement>('.srv .x')?.click();
      // The signal landed and the port freed, so the row comes back as the
      // branch's own again. A listener's row has no status either side of the
      // press, so nothing here would settle if the mark watched one — it would
      // sit `stopping` over a dead listener until the deadline, with no Run.
      withRows(p, [row({ runnerId: 'dev' })]);
      assert.equal(p.window.document.querySelector('.srv'), null, 'still on the line');
      assert.ok(p.window.document.querySelector('.sdoor'), 'no way to start it again');
    });

    it('opens the server, as a running record does', (t) => {
      const p = openPanel(t);
      withRows(p, [alien()]);
      p.window.document.querySelector<HTMLElement>('.srv .cbody')?.click();
      assert.deepEqual(p.posted.at(-1), { type: 'openServer', url: 'http://localhost:3000' });
    });

    it('opens a chip with no runner behind it, on a tree that runs nothing too', (t) => {
      const p = openPanel(t);
      for (const over of [
        { runnerId: '', label: 'node', app: 'apps/web' },
        { runnerId: '', label: 'nothing to start here', unrunnable: true }
      ]) {
        withRows(p, [alien(over)]);
        const body = p.window.document.querySelector('.srv .cbody');
        assert.equal(body?.getAttribute('data-act'), 'openServer');
      }
    });

    it('opens the server on a tree with scripts it would not choose between', (t) => {
      const p = openPanel(t);
      withRows(p, [alien({ runnerId: '', candidates: ['dev', 'start'], unrunnable: true })]);
      const body = p.window.document.querySelector('.srv .cbody');
      assert.equal(body?.getAttribute('data-act'), 'openServer');
    });

    it('opens the server on a monorepo root too', (t) => {
      const p = openPanel(t);
      withRows(p, [alien({ runnerId: '', label: 'node', unrunnable: true, workspaces: true })]);
      const body = p.window.document.querySelector('.srv .cbody');
      assert.equal(body?.getAttribute('data-act'), 'openServer');
    });

    it('still says stopping when a server of ours is killed under it', (t) => {
      const p = openPanel(t);
      // `stopRun` drops our record at once while the process stays bound for a
      // beat, so the row spends a poll carrying a listener instead of a server.
      // The key must not move underneath it: `stopping` is written on the press
      // against cwd+runnerId, and a chip that cannot find its own entry skips
      // the one state that press exists to show.
      const live = row({ status: 'up', port: 3000, runnerId: 'dev' });
      withRows(p, [live]);
      p.window.document.querySelector<HTMLElement>('.srv .x')?.click();
      withRows(p, [alien({ runnerId: 'dev' })]);
      assert.ok(p.window.document.querySelector('.srv.stopping'), 'lost the press');
    });

    it('keeps two listeners in one directory as two chips', (t) => {
      const p = openPanel(t);
      const rows = [
        alien({ runnerId: '', port: 3000 }),
        alien({ runnerId: '', port: 3001, branch: 'main' })
      ];
      withRows(p, rows);
      // Twice: the first paint appends whatever it is given, and it is the morph
      // that reads keys. Two rows keyed alike survive one render and collapse on
      // the next, which is the poll three seconds later.
      withRows(p, rows);
      assert.equal(p.window.document.querySelectorAll('.srv').length, 2);
    });

    it('says in the tip what the line has no room for', (t) => {
      const p = openPanel(t);
      withRows(p, [alien()]);
      const rows = p.window.document.querySelector('.srv')?.getAttribute('data-tip-rows') ?? '';
      assert.match(rows, /node/);
      assert.match(rows, /4242/);
      assert.match(rows, /Fix login/);
    });
  });

  // What the paint hangs off. None of these assert a rule — the stylesheet is
  // hand-checked — but each is the DOM fact a rule in `ui/css/board.ts` needs
  // to be true, and every one of them was false before the chip's motion was
  // split from the card grid's.
  describe('the states a stop and a start are told apart by', () => {
    it('stops drawing the running dot the moment a stop is asked for', (t) => {
      const p = openPanel(t);
      const live = row({ status: 'up', port: 3000 });
      withRows(p, [live]);
      assert.ok(p.window.document.querySelector('.srv .dot.up'), 'no running dot to lose');
      p.window.document.querySelector<HTMLElement>('.srv .x')?.click();
      const node = p.window.document.querySelector('.srv.stopping');
      assert.ok(node, 'the click said nothing');
      // The record still says `up` for as long as the stop is in flight, so the
      // dot's class was the record's verbatim and the one chip going away was
      // the one drawing the colour of health.
      assert.equal(node?.querySelector('.dot.up'), null, 'a chip going away drew health');
    });

    it('keeps every slot of a chip its own node when an earlier one goes', (t) => {
      const p = openPanel(t);
      // The port slot precedes the word, so the word is what a positional morph
      // would hand the port's node to when the port leaves: the same observable
      // line, drawn out of the wrong elements, and nothing left for an exit to
      // play on. This used to follow the owner mark instead, which sat after
      // the word until row 71 took it off the chip — same hazard, one slot
      // along.
      withRows(p, [row({ status: 'failed', port: 3000, reason: 'port taken' })]);
      const said = p.window.document.querySelector('.srv .s');
      assert.ok(said, 'no word to follow');
      assert.ok(p.window.document.querySelector('.srv .p'), 'no port slot to remove');

      withRows(p, [row({ status: 'failed', reason: 'port taken' })]);
      assert.equal(p.window.document.querySelector('.srv .p'), null, 'the port survived');
      assert.equal(
        p.window.document.querySelector('.srv .s'),
        said,
        'the word was rebuilt out of the port it followed'
      );
    });

    it('keeps the pressed ✕ for its own exit, and not past it', (t) => {
      const p = openPanel(t);
      const live = row({ status: 'up', port: 3000 });
      withRows(p, [live]);
      p.window.document.querySelector<HTMLElement>('.srv .x')?.click();
      const gone = p.window.document.querySelector('.srv .x');
      // Still drawn, so the exit has something to play on — and inert, because
      // there is nothing left to press.
      assert.equal(gone?.tagName, 'SPAN', 'left a control that does nothing');
      assert.equal(gone?.getAttribute('aria-hidden'), 'true');
      assert.equal(gone?.getAttribute('data-act'), null, 'kept an act on a spent control');
      // Past the swallow and well inside the stop's own wait: the mark stands,
      // and the node it put there does not.
      const real = p.window.Date.now;
      p.window.Date.now = () => real() + 500;
      t.after(() => {
        p.window.Date.now = real;
      });
      withRows(p, [live]);
      assert.ok(p.window.document.querySelector('.srv.stopping'), 'the mark went early');
      assert.equal(p.window.document.querySelector('.srv .x'), null, 'the ✕ outstayed its exit');
    });
  });
});
