/**
 * The wait's board against a supplied complete table, for each brand's join
 * with what it reads from disk (`core/coordination/wait_board.ts`). A member
 * whose record or pid file could not be read is still running and holds the
 * wait; a member whose process ended is stopped; the deadline still delivers.
 */

import * as assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import { disposeHome, procStartFor, tempHome, testPlatform } from '../helpers';
import type { ProcessTable } from '../../core/scan';
import type { Session } from '../../core/model';
import type { WaitRecord } from '../../core/coordination/wait';

type Board = typeof import('../../core/coordination/wait_board');
type Wait = typeof import('../../core/coordination/wait');

let home: string;
let board: Board;
let wait: Wait;

const CLAUDE = 7101;
const CODEX = 7102;
const GROK = 7103;
const GONE = 7104;
const START = 1_700_000_000_000;
const NOW = START + 60_000;

before(async () => {
  home = await tempHome();
  board = await import('../../core/coordination/wait_board');
  wait = await import('../../core/coordination/wait');
});

after(async () => {
  await disposeHome(home);
});

afterEach(async () => {
  mock.restoreAll();
  await fsp.rm(path.join(home, '.squadron', 'live'), { recursive: true, force: true });
  await fsp.rm(path.join(home, '.claude', 'sessions'), { recursive: true, force: true });
  await fsp.rm(path.join(home, '.claude', 'jobs'), { recursive: true, force: true });
});

const proc = (pid: number) => ({ pid, ppid: 1, command: null, startedAt: START });

function table(): ProcessTable {
  return {
    complete: true,
    startSource: testPlatform() === 'win32' ? 'win32-filetime-ms-v1' : 'ps-lstart-v1',
    starts: new Map([CLAUDE, CODEX, GROK].map((pid) => [pid, START])),
    parents: new Map([CLAUDE, CODEX, GROK].map((pid) => [pid, 1])),
    groups: new Map(),
    shellParents: new Set(),
    claude: new Map([[CLAUDE, proc(CLAUDE)]]),
    codex: new Map([[CODEX, proc(CODEX)]]),
    grok: new Map([[GROK, proc(GROK)]])
  };
}

const session = (pid: number, brand: Session['brand']): Session => ({
  pid,
  brand,
  sessionId: `sid-${pid}`,
  cwd: home,
  name: `s${pid}`,
  status: 'idle',
  hasCommand: false,
  startedAt: START,
  updatedAt: START,
  transcript: '',
  windowId: 'window-b',
  source: 'owned'
});

async function publish(
  pid: number,
  brand: Session['brand'],
  status: Session['status'] = 'idle'
): Promise<void> {
  const dir = path.join(home, '.squadron', 'live');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, `${pid}.json`),
    JSON.stringify({
      schema: 1,
      session: { ...session(pid, brand), status },
      pending: [],
      queued: []
    })
  );
}

/** A `<pid>.json` that cannot be read as a file. */
async function unreadable(dir: string, pid: number): Promise<void> {
  await fsp.mkdir(path.join(dir, `${pid}.json`), { recursive: true });
}

async function pidFile(pid: number, over: Record<string, unknown> = {}): Promise<void> {
  await rawPidFile(pid, {
    pid,
    sessionId: `sid-${pid}`,
    cwd: home,
    status: 'idle',
    entrypoint: 'sdk-cli',
    procStart: procStartFor(START),
    ...over
  });
}

async function rawPidFile(pid: number, body: unknown): Promise<void> {
  const dir = path.join(home, '.claude', 'sessions');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${pid}.json`), JSON.stringify(body));
}

async function job(id: string, state: string): Promise<void> {
  const dir = path.join(home, '.claude', 'jobs', id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'state.json'), JSON.stringify({ state }));
}

const registered = (members: number[], extra: Partial<WaitRecord> = {}): WaitRecord => ({
  schema: 1,
  id: `w-${members.join('-')}`,
  requesterPid: 100,
  requesterSessionId: 'requester-session',
  members,
  createdAt: NOW - 60_000,
  expiresAt: NOW + 60_000,
  ...extra
});

async function resolve(members: number[], extra: Partial<WaitRecord> = {}) {
  const found = await board.waitBoard([], table(), () => false);
  return {
    found,
    out: wait.resolveWaits({
      waits: [registered(members, extra)],
      board: found.members,
      processes: found.processes,
      running: found.running,
      retired: found.retired,
      records: found.records,
      workflowStates: new Map([[registered(members).id, { state: 'ready' }]]),
      now: NOW
    })
  };
}

describe('a wait board whose records were read', () => {
  it('reports every brand idle, and a member whose process ended stopped', async () => {
    await pidFile(CLAUDE);
    await publish(CODEX, 'codex');
    await publish(GROK, 'grok');
    const { found, out } = await resolve([CLAUDE, CODEX, GROK, GONE]);
    assert.equal(found.records, 'complete');
    assert.deepEqual(
      out[0]?.members.map(({ pid, state }) => [pid, state]),
      [
        [CLAUDE, 'reported'],
        [CODEX, 'reported'],
        [GROK, 'reported'],
        [GONE, 'stopped']
      ]
    );
  });
});

describe('a wait board with a record it could not read', () => {
  it('holds a running Codex or Grok member whose publication is unreadable', async () => {
    const live = path.join(home, '.squadron', 'live');
    for (const pid of [CODEX, GROK]) {
      await unreadable(live, pid);
      const { found, out } = await resolve([pid]);
      assert.equal(found.records, 'unknown');
      assert.equal(
        found.members.some((member) => member.pid === pid),
        false
      );
      assert.deepEqual(out, [], `${pid} held`);
      await fsp.rm(live, { recursive: true, force: true });
    }
  });

  it('holds a running member whose publication is invalid', async () => {
    const live = path.join(home, '.squadron', 'live');
    await fsp.mkdir(live, { recursive: true });
    await fsp.writeFile(path.join(live, `${CODEX}.json`), '{"schema":2}');
    const { found, out } = await resolve([CODEX]);
    assert.equal(found.records, 'unknown');
    assert.deepEqual(out, []);
  });

  it('holds a running Claude member whose pid file is unreadable', async () => {
    await unreadable(path.join(home, '.claude', 'sessions'), CLAUDE);
    const { found, out } = await resolve([CLAUDE]);
    assert.equal(found.records, 'unknown');
    assert.deepEqual(out, []);
  });

  it('holds running members when a directory cannot be listed, and still stops one that ended', async () => {
    await pidFile(CLAUDE);
    await publish(CODEX, 'codex');
    await publish(GROK, 'grok');
    const readdir = fsp.readdir;
    mock.method(fsp, 'readdir', (async (dir: string, ...rest: unknown[]) => {
      if (/[\\/](live|sessions)$/.test(String(dir)))
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (readdir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest);
    }) as typeof fsp.readdir);
    const { found, out } = await resolve([CLAUDE, CODEX, GROK]);
    assert.equal(found.records, 'unknown');
    assert.deepEqual(out, []);
    const ended = await resolve([GONE]);
    assert.deepEqual(
      ended.out[0]?.members.map(({ pid, state }) => [pid, state]),
      [[GONE, 'stopped']]
    );
  });

  it('holds a workflow wait while records are unknown', async () => {
    await unreadable(path.join(home, '.squadron', 'live'), CODEX);
    const { out } = await resolve([CODEX], { workflow: { workflowId: 'ship' } });
    assert.deepEqual(out, []);
  });

  it('delivers at the deadline, with the unread member as unread', async () => {
    await unreadable(path.join(home, '.squadron', 'live'), GROK);
    const { out } = await resolve([GROK, GONE], { expiresAt: NOW });
    assert.equal(out[0]?.expired, true);
    assert.deepEqual(
      out[0]?.members.map(({ pid, state }) => [pid, state]),
      [
        [GROK, 'unread'],
        [GONE, 'stopped']
      ]
    );
  });
});

describe('a wait board read once per pass', () => {
  it('builds the board and its confidence from one listing of each store', async () => {
    await pidFile(CLAUDE);
    await publish(CODEX, 'codex', 'busy');
    await publish(GROK, 'grok');
    const readdir = fsp.readdir;
    const listed: string[] = [];
    mock.method(fsp, 'readdir', (async (dir: string, ...rest: unknown[]) => {
      listed.push(path.basename(String(dir)));
      // A display-only read path failing must not leave a board that a
      // successful second read then certifies.
      if (/[\\/]live$/.test(String(dir)) && /readJsonDir/.test(String(new Error().stack)))
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (readdir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest);
    }) as typeof fsp.readdir);
    const { found, out } = await resolve([CODEX]);
    assert.ok(
      found.members.some((member) => member.pid === CODEX),
      'the busy Codex lane is on the board'
    );
    assert.equal(found.records, 'complete');
    assert.deepEqual(out, [], 'busy, so pending');
    assert.deepEqual(
      listed.filter((name) => name === 'live' || name === 'sessions').sort(),
      ['live', 'sessions'],
      'one listing of each'
    );
  });

  for (const [what, body] of [
    ['null', null],
    ['an empty object', {}],
    ['an array', []],
    ['a pid that is not a number', { pid: 'x', procStart: procStartFor(START) }],
    ['another pid than its name', { pid: CLAUDE + 1000, procStart: procStartFor(START) }],
    ['a start that is not a string', { pid: CLAUDE, procStart: 5 }]
  ] as const) {
    it(`holds a running Claude member whose pid file is parseable but invalid: ${what}`, async () => {
      await rawPidFile(CLAUDE, body);
      const { found, out } = await resolve([CLAUDE], { workflow: { workflowId: 'ship' } });
      assert.equal(found.records, 'unknown');
      assert.deepEqual(out, []);
    });
  }

  // On `ps` a named `claude` row proves the process without a start, so only
  // the FILETIME clock, which needs one, holds these.
  for (const [what, procStart] of [
    ['no start', undefined],
    ['an empty start', ''],
    ['a start that does not parse', 'garbage']
  ] as const) {
    it(`holds a running Claude member whose pid file has ${what} on a clock that needs one`, async () => {
      await pidFile(CLAUDE, { procStart });
      const { found, out } = await resolve([CLAUDE], { workflow: { workflowId: 'ship' } });
      if (testPlatform() === 'win32') {
        assert.equal(found.records, 'unknown');
        assert.deepEqual(out, []);
      } else {
        assert.ok(
          found.members.some((member) => member.pid === CLAUDE),
          'named, so on the board'
        );
      }
    });
  }

  it('reads a valid start of an older process as stale, not unread', async () => {
    await pidFile(CLAUDE, { procStart: procStartFor(START - 60_000) });
    const { found } = await resolve([CLAUDE]);
    assert.equal(found.records, 'complete');
  });

  it('reads a valid file of a session typed at a terminal as read, not unread', async () => {
    await pidFile(CLAUDE, { entrypoint: 'cli' });
    const { found } = await resolve([GONE]);
    assert.equal(found.records, 'complete');
  });
});

describe('a wait on a background job whose pooled worker runs on', () => {
  for (const state of ['done', 'failed']) {
    it(`converges when the job is ${state}`, async () => {
      await pidFile(CLAUDE, { kind: 'daemon-worker', jobId: `job-${state}`, entrypoint: '' });
      await job(`job-${state}`, state);
      const { found, out } = await resolve([CLAUDE]);
      assert.equal(found.records, 'complete');
      assert.equal(
        found.members.some((member) => member.pid === CLAUDE),
        false
      );
      assert.deepEqual(
        out[0]?.members.map(({ pid, state: outcome }) => [pid, outcome]),
        [[CLAUDE, 'stopped']]
      );
    });
  }

  it('stays pending while the job is busy', async () => {
    await pidFile(CLAUDE, {
      kind: 'daemon-worker',
      jobId: 'job-busy',
      entrypoint: '',
      status: 'busy'
    });
    await job('job-busy', 'running');
    const { found, out } = await resolve([CLAUDE]);
    assert.ok(found.members.some((member) => member.pid === CLAUDE));
    assert.deepEqual(out, []);
  });
});

/**
 * An owned member whose record or pid file went unread has no discovery twin,
 * and the live half says `hasCommand: false` for every session it builds. The
 * board reads the command off the table itself, so an idle member whose tool
 * shell still runs is not finished.
 */
describe('a wait board over an owned member with no twin', () => {
  const owned = [session(CLAUDE, 'claude'), session(CODEX, 'codex'), session(GROK, 'grok')];

  async function pass(shells: number[], ended: (pid: number) => boolean = () => false) {
    const found = await board.waitBoard(
      owned,
      { ...table(), shellParents: new Set(shells) },
      ended
    );
    return (extra: Partial<WaitRecord> = {}) =>
      wait.resolveWaits({
        waits: [registered([CLAUDE, CODEX, GROK], extra)],
        board: found.members,
        processes: found.processes,
        running: found.running,
        retired: found.retired,
        records: found.records,
        now: NOW
      });
  }

  async function unreadAll(): Promise<void> {
    await unreadable(path.join(home, '.claude', 'sessions'), CLAUDE);
    await unreadable(path.join(home, '.squadron', 'live'), CODEX);
    await unreadable(path.join(home, '.squadron', 'live'), GROK);
  }

  it('holds an idle member whose tool shell runs, then reports it once the shell is gone', async () => {
    await unreadAll();
    for (const pid of [CLAUDE, CODEX, GROK]) {
      const shells = [pid];
      assert.deepEqual((await pass(shells))(), [], `${pid} holds while its command runs`);
    }
    const out = (await pass([]))();
    assert.deepEqual(
      out[0]?.members.map(({ pid, state }) => [pid, state]),
      [
        [CLAUDE, 'reported'],
        [CODEX, 'reported'],
        [GROK, 'reported']
      ]
    );
  });

  it('holds on the same command once the records read again', async () => {
    await pidFile(CLAUDE);
    await publish(CODEX, 'codex');
    await publish(GROK, 'grok');
    assert.deepEqual((await pass([CODEX]))(), []);
  });

  it('stops a member whose exit this window watched, command or not', async () => {
    await unreadAll();
    const out = (await pass([CLAUDE, CODEX, GROK], () => true))();
    assert.deepEqual(
      out[0]?.members.map(({ pid, state }) => [pid, state]),
      [
        [CLAUDE, 'stopped'],
        [CODEX, 'stopped'],
        [GROK, 'stopped']
      ]
    );
  });

  it('delivers at the deadline with the member still running a command as unread', async () => {
    await unreadAll();
    const out = (await pass([CODEX]))({ expiresAt: NOW });
    assert.equal(out[0]?.expired, true);
    assert.deepEqual(
      out[0]?.members.map(({ pid, state }) => [pid, state]),
      [
        [CLAUDE, 'reported'],
        [CODEX, 'unread'],
        [GROK, 'reported']
      ]
    );
  });

  it('reads every member as running a command on a table that is not complete', async () => {
    const found = await board.waitBoard(owned, { ...table(), complete: false }, () => false);
    assert.equal(found.processes, 'unknown');
    assert.deepEqual(
      found.members.map((member) => member.hasCommand),
      [true, true, true]
    );
  });
});

/**
 * An npm-installed Codex member: the owned card is the `node codex.js` root,
 * and its tool shell is a child of the native `codex` below it. With its record
 * unread there is no twin, and the board still reads the shell.
 */
describe('a wait board over a wrapped Codex member with no twin', () => {
  const ROOT = 7201;
  const NATIVE = 7202;
  const wrapped = (shells: number[]): ProcessTable => {
    const base = table();
    return {
      ...base,
      starts: new Map([...base.starts, [ROOT, START], [NATIVE, START]]),
      parents: new Map([...base.parents, [ROOT, 1], [NATIVE, ROOT]]),
      codex: new Map([[NATIVE, { pid: NATIVE, ppid: ROOT, command: null, startedAt: START }]]),
      shellParents: new Set(shells)
    };
  };

  it('holds while the native child runs a shell, and reports once it has none', async () => {
    await unreadable(path.join(home, '.squadron', 'live'), ROOT);
    const resolveOver = async (shells: number[]) => {
      const found = await board.waitBoard([session(ROOT, 'codex')], wrapped(shells), () => false);
      return wait.resolveWaits({
        waits: [registered([ROOT])],
        board: found.members,
        processes: found.processes,
        running: found.running,
        retired: found.retired,
        records: found.records,
        now: NOW
      });
    };
    assert.deepEqual(await resolveOver([NATIVE]), []);
    assert.deepEqual(
      (await resolveOver([]))[0]?.members.map(({ pid, state }) => [pid, state]),
      [[ROOT, 'reported']]
    );
  });
});
