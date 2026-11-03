import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as sheet from '../../ui/server_sheet';

const TREE = '/Users/me/src/acme-web';

const row = (over: Partial<ServerRowView> = {}): ServerRowView => ({
  branch: 'main',
  tree: TREE,
  cwd: TREE,
  runnerId: 'dev',
  label: 'npm run dev',
  ...over
});

const start = (over: Partial<RunStart> = {}): RunStart => ({
  cwd: TREE,
  runnerId: 'dev',
  label: 'npm run dev',
  key: 'dev',
  ...over
});

describe('the rail', () => {
  it('draws one entry per worktree, running above idle', () => {
    const idle = row({ tree: '/t/idle', cwd: '/t/idle', branch: 'idle' });
    const up = row({ tree: '/t/up', cwd: '/t/up', branch: 'up', status: 'up', port: 3000 });
    const entries = sheet.worktrees([idle, up]);
    assert.deepEqual(
      entries.map((e) => e.branch),
      ['up', 'idle']
    );
  });

  it('folds two apps of one worktree and counts the second port', () => {
    const [entry] = sheet.worktrees([
      row({ cwd: `${TREE}/apps/web`, app: 'apps/web', status: 'up', port: 3001 }),
      row({ cwd: `${TREE}/apps/admin`, app: 'apps/admin', status: 'starting', port: 3002 }),
      row({ runnerId: '', unrunnable: true, workspaces: true })
    ]);
    assert.equal(entry?.dot, 'starting');
    assert.equal(entry?.meta, ':3001 +1');
    assert.equal(entry?.rows.length, 3);
  });

  it('puts a failure on the dot and in the words', () => {
    const [entry] = sheet.worktrees([
      row({ status: 'up', port: 3001 }),
      row({ status: 'failed', port: 3002, reason: 'port taken' })
    ]);
    assert.equal(entry?.dot, 'failed');
    assert.equal(entry?.meta, 'port taken');
    assert.equal(entry?.failed, true);
  });
});

describe('the starts', () => {
  it('joins a start to the server running it', () => {
    const live = row({ status: 'up', port: 3000 });
    const [first] = sheet.startRows([live], [start()]);
    assert.equal(first?.live, live);
  });

  it('splits an app from its runner', () => {
    const [first] = sheet.startRows(
      [],
      [start({ label: 'apps/web · npm run dev', key: 'apps/web:dev' })]
    );
    assert.equal(first?.name, 'apps/web');
    assert.equal(first?.runner, 'npm run dev');
  });

  it('keeps a live server no start offers, so it can still be stopped', () => {
    const live = row({
      runnerId: '',
      label: 'next dev',
      port: 3003,
      listener: { command: 'next dev', pid: 7, startedAt: 1, session: 'Fix billing' }
    });
    const drawn = sheet.startRows([live], [start()]);
    assert.equal(drawn.length, 2);
    assert.equal(drawn[1]?.live, live);
    assert.equal(drawn[1]?.start, undefined);
  });

  it('names a session server by its command, not the tree’s sentence', () => {
    const live = row({
      runnerId: '',
      label: 'nothing to start here',
      unrunnable: true,
      port: 3003,
      listener: { command: 'next dev', pid: 7, startedAt: 1, session: 'Fix billing' }
    });
    assert.equal(sheet.startRows([live], [])[0]?.name, 'next dev');
  });

  it('draws live rows before any answer has landed', () => {
    const live = row({ status: 'up', port: 3000 });
    assert.equal(sheet.startRows([live, row({ runnerId: 'x' })], []).length, 1);
  });
});

describe('the default port', () => {
  const free = (port: number): PortsMessage['ports'][number] => ({ port, free: true });
  const taken = (port: number): PortsMessage['ports'][number] => ({ port, free: false });

  it('prefers what this start used last', () => {
    assert.equal(sheet.defaultPort(start(), [free(3000), free(3001)], { dev: 3001 }), 3001);
  });

  it('never offers a remembered port that has been taken', () => {
    assert.equal(sheet.defaultPort(start(), [taken(3000), free(3001)], { dev: 3000 }), 3001);
  });

  it('has nothing for a start that takes no port', () => {
    assert.equal(sheet.defaultPort(start({ portless: true }), [free(3000)], {}), undefined);
  });

  it('has nothing when the block is full', () => {
    assert.equal(sheet.defaultPort(start(), [taken(3000)], {}), undefined);
  });

  it('takes the first free port of the start’s own block, not of the union', () => {
    const astro = start({ block: { base: 4321, span: 2 } });
    assert.equal(sheet.defaultPort(astro, [free(3000), taken(4321), free(4322)], {}), 4322);
  });

  it('prefers a remembered port outside the start’s block when the answer carries it free', () => {
    // An astro app that took 3000 before blocks were derived.
    const astro = start({ block: { base: 4321, span: 2 } });
    assert.equal(sheet.defaultPort(astro, [free(3000), free(4321)], { dev: 3000 }), 3000);
  });

  it('passes over a remembered outside port that is taken, refused or not answered', () => {
    const astro = start({ block: { base: 4321, span: 2 } });
    assert.equal(sheet.defaultPort(astro, [taken(3000), free(4321)], { dev: 3000 }), 4321);
    assert.equal(sheet.defaultPort(astro, [free(6000), free(4321)], { dev: 6000 }), 4321);
    assert.equal(sheet.defaultPort(astro, [free(4321)], { dev: 3000 }), 4321);
  });

  it('has nothing when the start’s own block is full, whatever the union has free', () => {
    const astro = start({ block: { base: 4321, span: 1 } });
    assert.equal(sheet.defaultPort(astro, [free(3000), taken(4321)], {}), undefined);
  });

  it('never arms a port a browser refuses, remembered or first free', () => {
    const x11 = start({ block: { base: 6000, span: 2 } });
    assert.equal(sheet.defaultPort(x11, [free(6000), free(6001)], { dev: 6000 }), 6001);
    assert.equal(sheet.defaultPort(x11, [free(6000), free(6001)], {}), 6001);
  });
});

describe('a start’s rows', () => {
  const ports: PortsMessage['ports'] = [
    { port: 3000, free: true },
    { port: 4321, free: false },
    { port: 4322, free: true },
    { port: 5173, free: true }
  ];

  it('keeps the rows inside the start’s block, in order', () => {
    assert.deepEqual(
      sheet.blockRows(start({ block: { base: 4321, span: 10 } }), ports).map((row) => row.port),
      [4321, 4322]
    );
  });

  it('gives a start with no block every row, as an older host sent it', () => {
    assert.deepEqual(sheet.blockRows(start(), ports), ports);
  });
});

describe('a start’s outside row', () => {
  const ports: PortsMessage['ports'] = [
    { port: 3000, free: true },
    { port: 4321, free: true },
    { port: 5174, free: false }
  ];
  const astro = start({ block: { base: 4321, span: 2 } });

  it('is the remembered port when the answer has it and the block does not', () => {
    assert.deepEqual(sheet.outsideRow(astro, ports, { dev: 3000 }), { port: 3000, free: true });
    assert.deepEqual(sheet.outsideRow(astro, ports, { dev: 5174 }), { port: 5174, free: false });
  });

  it('is nothing inside the block, unanswered, unremembered, or with no block', () => {
    assert.equal(sheet.outsideRow(astro, ports, { dev: 4321 }), undefined);
    assert.equal(sheet.outsideRow(astro, ports, { dev: 8787 }), undefined);
    assert.equal(sheet.outsideRow(astro, ports, {}), undefined);
    assert.equal(sheet.outsideRow(start(), ports, { dev: 3000 }), undefined);
  });
});

describe('the live signature', () => {
  it('moves when a server takes a port and not when it comes up', () => {
    const before = sheet.liveSignature([row({ status: 'starting', port: 3000 })]);
    assert.equal(before, sheet.liveSignature([row({ status: 'up', port: 3000 })]));
    assert.notEqual(before, sheet.liveSignature([row({ status: 'up', port: 3001 })]));
    assert.equal(sheet.liveSignature([row()]), '');
  });
});
