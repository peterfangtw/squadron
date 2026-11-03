/**
 * Step 4 controls for Windows processes: `win32-filetime-ms-v1` identity
 * through Claude discovery, the incoming codecs, self resolution, host capture
 * and durable admission records. Every table is supplied, so these run on any
 * OS; production selection still refuses Windows snapshots (Step 6).
 */

import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it, type TestContext } from 'node:test';
import * as scan from '../../core/scan';
import * as incoming from '../../core/incoming';
import * as processes from '../../core/platform/processes';
import * as win32PrivateFiles from '../../core/platform/private_files/win32';
import type { SessionHandle } from '../../core/adapter';
import type { SessionTransport } from '../../core/session';
import type { HostIdentity, ReceiverIdentity } from '../../core/bridge/model';
import type { PublishedLive } from '../../core/published';
import * as fixtures from '../incoming_helpers';
import * as helpers from '../helpers';

const WIN = 'win32-filetime-ms-v1' as const;
const PS = 'ps-lstart-v1' as const;
const EPOCH = 116_444_736_000_000_000n;
const HOST = process.pid;

let home: string;
let cwd: string;
let paths: typeof import('../../core/paths');
before(async () => {
  home = await helpers.tempHome();
  cwd = await fs.realpath(home);
  paths = await import('../../core/paths');
});

function row(pid: number, ppid: number, startedAt: number, image: string): processes.Row {
  return {
    pid,
    ppid,
    startedAt,
    image,
    command: `${image} -p`,
    invocation: { program: image, args: '-p' }
  };
}

function table(
  rows: processes.Row[],
  source: processes.StartSource = WIN,
  complete = true
): scan.ProcessTable {
  const value = { source, rows };
  return scan.tableOf(
    complete
      ? { supported: true, status: 'ok', value }
      : { supported: true, status: 'incomplete', value, reason: 'partial' }
  );
}

function supply(t: TestContext, ...tables: scan.ProcessTable[]): void {
  let next = 0;
  t.mock.method(scan, 'scanProcesses', () =>
    Promise.resolve(tables[Math.min(next++, tables.length - 1)])
  );
}

function hostOf(source: processes.StartSource = WIN): HostIdentity {
  return { ...fixtures.host, pid: 10, osStartedAt: 1000, startSource: source };
}

function receiverOf(pid = 20, host = hostOf()): ReceiverIdentity {
  return {
    ...fixtures.receiver,
    host,
    pid,
    osStartedAt: 2000,
    startSource: host.startSource,
    brand: 'claude'
  };
}

describe('start vocabulary', () => {
  it('names exactly the two supported clocks', () => {
    assert.equal(processes.isStartSource(PS), true);
    assert.equal(processes.isStartSource(WIN), true);
    for (const other of ['win32-dmtf-v1', 'PS-LSTART-V1', '', undefined, 1])
      assert.equal(processes.isStartSource(other), false, String(other));
  });

  it('floors FILETIME with integer precision past 2^53', () => {
    // One tick below a millisecond boundary: a float parse rounds it up to the boundary.
    const boundary = (EPOCH + 1_792_931_583_814n * 10_000n).toString();
    const below = (BigInt(boundary) - 1n).toString();
    assert.equal(Math.floor((Number(below) - Number(EPOCH)) / 10_000), 1_792_931_583_814);
    assert.equal(processes.filetimeToUnixMs(below), 1_792_931_583_813);
    assert.equal(processes.filetimeToUnixMs(boundary), 1_792_931_583_814);
  });
});

describe('Claude FILETIME procStart', () => {
  const ticks = (EPOCH + 1_792_931_583_813n * 10_000n).toString();
  const ms = 1_792_931_583_813;

  async function discovered(
    t: TestContext,
    procStart: unknown,
    source: processes.StartSource,
    image = 'claude.exe'
  ): Promise<number[]> {
    const discover = await import('../../core/claude/discover');
    supply(t, table([row(100, 10, ms, image)], source));
    const file = path.join(home, '.claude', 'sessions', '100.json');
    try {
      await helpers.writeJson(file, {
        pid: 100,
        sessionId: 'filetime',
        entrypoint: 'sdk-cli',
        cwd: home,
        procStart
      });
      return (await discover.discover()).map((session) => session.pid);
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  it('keeps a pid file whose FILETIME floors to the table start', async (t) => {
    assert.deepEqual(await discovered(t, ticks, WIN), [100]);
    // The 100 ns digits under the millisecond are not identity.
    assert.deepEqual(await discovered(t, (BigInt(ticks) + 6789n).toString(), WIN), [100]);
  });

  it('drops one a millisecond off, or malformed', async (t) => {
    for (const procStart of [
      (BigInt(ticks) + 10_000n).toString(),
      (BigInt(ticks) - 1n).toString(),
      `0${ticks}`,
      `${ticks}.0`,
      Number(ticks)
    ])
      assert.deepEqual(await discovered(t, procStart, WIN), [], String(procStart));
  });

  it('never matches FILETIME against a ps lstart table', async (t) => {
    // A ps row not named claude has only the start to prove it.
    assert.deepEqual(await discovered(t, ticks, PS, 'node'), []);
  });
});

describe('incoming codecs carry the source', () => {
  const host = hostOf();
  const receiver = receiverOf();

  it('round-trips Windows host, receiver, holder, attempt, launch and delivery', () => {
    assert.deepEqual(incoming.readHostIdentity(host), host);
    assert.deepEqual(incoming.readReceiverIdentity(receiver), receiver);
    const holder = { host, generation: 1 };
    assert.deepEqual(incoming.readIncomingHolder(holder), holder);
    const attempt = {
      ...fixtures.attempt,
      host,
      holder,
      cwd: receiver.cwd,
      target: {},
      selection: 'default' as const
    };
    assert.deepEqual(incoming.readLaunchAttempt(attempt), attempt);
    const launch = { ...fixtures.launch, attempt, receiver };
    assert.deepEqual(incoming.readRemoteLaunchEvidence(launch), launch);
    const delivery = { ...fixtures.delivery, receiver };
    assert.deepEqual(incoming.readIncomingDelivery(delivery), delivery);
    assert.equal(incoming.sameHost(host, hostOf(PS)), false);
  });

  it('keeps legacy ps lstart identities readable', () => {
    assert.deepEqual(incoming.readReceiverIdentity(fixtures.receiver), fixtures.receiver);
  });

  it('refuses an unknown source and a receiver on another clock than its host', () => {
    assert.equal(incoming.readHostIdentity({ ...host, startSource: 'win32-dmtf-v1' }), undefined);
    assert.equal(incoming.readHostIdentity({ ...host, startSource: undefined }), undefined);
    assert.equal(incoming.readReceiverIdentity({ ...receiver, startSource: PS }), undefined);
    assert.equal(
      incoming.readReceiverIdentity({ ...receiverOf(20, hostOf(PS)), startSource: WIN }),
      undefined
    );
  });

  it('proves owner death only on the owner’s own clock and a complete table', () => {
    const dead = table([row(10, 1, 999, 'code.exe')]);
    assert.equal(incoming.ownerDead(host, dead), true);
    assert.equal(incoming.ownerDead(host, table([row(10, 1, 1000, 'code.exe')])), false);
    assert.equal(incoming.ownerDead(hostOf(PS), dead), false);
    assert.equal(incoming.ownerDead(host, table([row(10, 1, 999, 'code.exe')], WIN, false)), false);
  });
});

describe('remote holder exact host', () => {
  it('names an incoming holder only on its own clock', async (t) => {
    const holder = await import('../../core/remote/holder');
    const host = { ...hostOf(PS), pid: HOST, windowId: 'w-holder' };
    const current = { host, generation: 1 };
    await fs.mkdir(paths.REMOTE_DIR, { recursive: true });
    await fs.writeFile(
      paths.HOLDER_FILE,
      JSON.stringify({
        windowId: host.windowId,
        label: 'holder',
        pid: HOST,
        startedAt: host.osStartedAt,
        since: 0,
        incoming: current
      })
    );
    try {
      supply(t, table([row(HOST, 1, host.osStartedAt, 'code.exe')], PS));
      assert.equal((await holder.incomingHolderNow(host.windowId, current))?.pid, HOST);
      t.mock.restoreAll();
      supply(t, table([row(HOST, 1, host.osStartedAt, 'code.exe')], WIN));
      assert.equal(await holder.incomingHolderNow(host.windowId, current), undefined);
    } finally {
      await fs.rm(paths.HOLDER_FILE, { force: true });
    }
  });
});

describe('self resolution on a Windows table', () => {
  const record = (identity: ReceiverIdentity, pid = identity.pid): PublishedLive => ({
    schema: 1,
    receiverIdentity: identity,
    pending: [],
    queued: [],
    session: {
      pid,
      sessionId: 'same-id',
      startedAt: identity.osStartedAt,
      cwd: identity.cwd,
      name: '',
      transcript: '',
      updatedAt: 0,
      status: 'idle',
      hasCommand: false,
      source: 'owned',
      windowId: identity.host.windowId,
      brand: identity.brand
    }
  });

  async function nearest(
    rows: processes.Row[],
    identity: ReceiverIdentity,
    key = identity.pid,
    source: processes.StartSource = WIN,
    complete = true
  ): Promise<ReceiverIdentity | undefined> {
    const cli = await import('../../cli/self');
    return cli.nearestOwnedReceiver(
      30,
      table(rows, source, complete),
      new Map([[key, record(identity, key)]])
    );
  }

  const tool = row(30, 20, 3000, 'bash.exe');
  const cli = row(20, 10, 2000, 'claude.exe');
  const ide = row(10, 1, 1000, 'code.exe');

  it('admits the CLI launched directly by the exact host', async () => {
    assert.deepEqual(await nearest([tool, cli, ide], receiverOf()), receiverOf());
  });

  it('refuses a native CLI under a wrapper root: the root is not its identity', async () => {
    // Human decision 2: the wrapper is the root and the CLI only its member.
    // No durable evidence names that member yet, and an unnamed owned root
    // with a named child is also the CLI barrier `fetch_cli` pins.
    const wrapped = [tool, row(20, 15, 2000, 'claude.exe'), row(15, 10, 1500, 'node.exe'), ide];
    const root = { ...receiverOf(), pid: 15, osStartedAt: 1500 };
    assert.equal(await nearest(wrapped, root, 15), undefined);
    assert.equal(await nearest(wrapped, receiverOf(), 15), undefined);
    assert.equal(await nearest(wrapped, receiverOf(), 20), undefined);
  });

  it('denies mixed sources, a recycled host and partial tables', async () => {
    assert.equal(await nearest([tool, cli, ide], receiverOf(20, hostOf(PS))), undefined);
    assert.equal(await nearest([tool, cli, ide], receiverOf(), 20, PS), undefined);
    assert.equal(await nearest([tool, cli, ide], receiverOf(), 20, WIN, false), undefined);
    assert.equal(await nearest([tool, cli, row(10, 1, 1001, 'code.exe')], receiverOf()), undefined);
    // A host newer than its CLI is a recycled pid: scan refutes the edge.
    assert.equal(await nearest([tool, cli, row(10, 1, 2500, 'code.exe')], receiverOf()), undefined);
  });
});

describe('host capture on a Windows table', () => {
  const ide = row(HOST, 1, 1000, 'code.exe');

  function stubs(pid: number): { transport: SessionTransport; session: SessionHandle } {
    return {
      transport: { pid, processAlive: () => true } as unknown as SessionTransport,
      session: {
        state: { cwd, sessionId: 'current' },
        onChange: () => () => undefined
      } as unknown as SessionHandle
    };
  }

  async function captured(
    t: TestContext,
    rows: processes.Row[],
    root: number,
    later = rows
  ): Promise<ReceiverIdentity | undefined> {
    const owned = await import('../../core/owned_incoming');
    supply(t, table(rows), table(later));
    const host = new owned.IncomingHost('w-win');
    const { transport, session } = stubs(root);
    return (await host.capture(transport, session, 'claude', () => true))?.receiverIdentity;
  }

  it('captures a direct native CLI with the Windows source', async (t) => {
    const receiver = await captured(t, [ide, row(20, HOST, 2000, 'claude.exe')], 20);
    assert.equal(receiver?.pid, 20);
    assert.equal(receiver?.startSource, WIN);
    assert.equal(receiver?.host.startSource, WIN);
    assert.equal(receiver?.host.pid, HOST);
  });

  it('captures a wrapper root as itself, never as the native CLI below it', async (t) => {
    const rows = [ide, row(15, HOST, 1500, 'node.exe'), row(20, 15, 2000, 'claude.exe')];
    const receiver = await captured(t, rows, 15);
    assert.equal(receiver?.pid, 15);
    assert.equal(receiver?.osStartedAt, 1500);
    t.mock.restoreAll();
    // The native CLI is not the host's child, so it is no receiver of its own.
    assert.equal(await captured(t, rows, 20), undefined);
  });

  it('refuses a recycled host and an incomplete scan', async (t) => {
    const direct = [ide, row(20, HOST, 2000, 'claude.exe')];
    assert.equal(
      await captured(t, direct, 20, [row(HOST, 1, 1001, 'code.exe'), direct[1]!]),
      undefined
    );
    t.mock.restoreAll();
    const owned = await import('../../core/owned_incoming');
    supply(t, table(direct, WIN, false));
    const host = new owned.IncomingHost('w-win');
    const { transport, session } = stubs(20);
    assert.equal(await host.capture(transport, session, 'claude', () => true), undefined);
  });

  it('keeps Windows evidence live only while the receiver holds its start', async (t) => {
    const owned = await import('../../core/owned_incoming');
    const rows = [ide, row(20, HOST, 2000, 'claude.exe')];
    const recycled = [ide, row(20, HOST, 2001, 'claude.exe')];
    // Activation, capture, then one ownership read per evidence demand.
    supply(t, table(rows), table(rows), table(rows), table(recycled));
    const host = new owned.IncomingHost('w-win');
    const { transport, session } = stubs(20);
    const entry = await host.capture(transport, session, 'claude', () => true);
    assert.ok(entry);
    const query = { kind: 'receiver' as const, receiver: entry.receiverIdentity };
    assert.ok(await entry.evidence(crypto.randomUUID(), query, () => Promise.resolve(true)));
    assert.equal(
      await entry.evidence(crypto.randomUUID(), query, () => Promise.resolve(true)),
      undefined
    );
  });

  it('still refuses private files on exact Windows process proof', async (t) => {
    const owned = await import('../../core/owned_incoming');
    const platform = await import('../../core/platform');
    t.mock.method(platform.privateFiles, 'ensure', win32PrivateFiles.privateFiles().ensure);
    supply(t, table([ide]));
    const host = new owned.IncomingHost('w-win');
    assert.equal(await host.capability(), undefined);
  });
});

describe('durable admission identity on a Windows table', () => {
  let ownerClaim: typeof import('../../core/coordination/owner_claim');
  let records: typeof import('../../core/coordination/startup_records');
  before(async () => {
    ownerClaim = await import('../../core/coordination/owner_claim');
    records = await import('../../core/coordination/startup_records');
  });

  const me = row(HOST, 1, 5000, 'code.exe');

  async function reset(): Promise<void> {
    await fs.rm(paths.STARTUPS_DIR, { recursive: true, force: true });
    await fs.mkdir(paths.STARTUPS_DIR, { recursive: true });
  }

  async function readJson(name: string): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(path.join(paths.STARTUPS_DIR, name), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  it('reads owners: legacy untagged and either tag, never an unknown one', () => {
    const legacy = { pid: 50, startedAt: 1, generation: 'g' };
    assert.equal(ownerClaim.owner(legacy), true);
    assert.equal(ownerClaim.owner({ ...legacy, startSource: WIN }), true);
    assert.equal(ownerClaim.owner({ ...legacy, startSource: PS }), true);
    assert.equal(ownerClaim.owner({ ...legacy, startSource: 'win32-dmtf-v1' }), false);
    assert.equal(ownerClaim.sourceOf(legacy), PS);
    assert.equal(ownerClaim.sourceOf({ ...legacy, startSource: WIN }), WIN);
  });

  it('admits on a complete Windows table and refuses a partial one', async (t) => {
    supply(t, table([me]));
    assert.equal((await ownerClaim.native()).startSource, WIN);
    t.mock.restoreAll();
    supply(t, table([me], WIN, false));
    await assert.rejects(ownerClaim.native(), /Native process identity is unavailable/);
  });

  it('tags new receipts, bound children and remembered members with the source', async (t) => {
    await reset();
    supply(t, table([me, row(60, HOST, 6000, 'claude.exe')]));
    const slot = await records.reserveStartup('tagged');
    await slot.spawning();
    await slot.bind(60);
    await slot.remember([{ pid: 61, startedAt: 6100 }]);
    const raw = await readJson('tagged.json');
    assert.deepEqual(raw.owner, {
      pid: HOST,
      startedAt: 5000,
      startSource: WIN,
      generation: (raw.owner as { generation: string }).generation
    });
    assert.deepEqual(raw.child, { pid: 60, startedAt: 6000, startSource: WIN });
    assert.deepEqual(raw.members, [{ pid: 61, startedAt: 6100, startSource: WIN }]);
    await slot.release();
  });

  it('never settles a legacy POSIX reservation on Windows evidence', async (t) => {
    await reset();
    const legacy = {
      schema: 1,
      id: 'legacy',
      admittedAt: Date.now(),
      owner: { pid: 50, startedAt: 1, generation: 'legacy' },
      phase: 'spawned',
      child: { pid: 51, startedAt: 2 },
      members: [{ pid: 52, startedAt: 3 }]
    };
    const dead = {
      ...legacy,
      id: 'dead',
      owner: { ...legacy.owner, startSource: WIN },
      child: { ...legacy.child, startSource: WIN },
      members: [{ ...legacy.members[0], startSource: WIN }]
    };
    await fs.writeFile(path.join(paths.STARTUPS_DIR, 'legacy.json'), JSON.stringify(legacy));
    await fs.writeFile(path.join(paths.STARTUPS_DIR, 'dead.json'), JSON.stringify(dead));
    supply(t, table([me]));
    const slot = await records.reserveStartup('after-legacy');
    await slot.release();
    assert.equal((await readJson('legacy.json')).phase, 'spawned');
    assert.deepEqual(await readJson('legacy.json'), legacy);
    assert.equal((await readJson('dead.json')).phase, 'settled');
  });

  it('retains a reservation while any remembered Windows member is live', async (t) => {
    await reset();
    const held = {
      schema: 1,
      id: 'held',
      admittedAt: Date.now(),
      owner: { pid: 50, startedAt: 1, startSource: WIN, generation: 'held' },
      phase: 'spawned',
      child: { pid: 51, startedAt: 2, startSource: WIN },
      members: [{ pid: 52, startedAt: 3, startSource: WIN }]
    };
    await fs.writeFile(path.join(paths.STARTUPS_DIR, 'held.json'), JSON.stringify(held));
    supply(t, table([me, row(52, 1, 3, 'bash.exe')]));
    const slot = await records.reserveStartup('beside-held');
    await slot.release();
    assert.equal((await readJson('held.json')).phase, 'spawned');
  });

  it('counts unresolved Windows capacity against the fleet limit', async (t) => {
    await reset();
    for (let i = 0; i < 16; i++)
      await fs.writeFile(
        path.join(paths.STARTUPS_DIR, `legacy-${i}.json`),
        JSON.stringify({
          schema: 1,
          id: `legacy-${i}`,
          admittedAt: Date.now() - 120_000,
          owner: { pid: 50 + i, startedAt: 1, generation: `legacy-${i}` },
          phase: 'reserved'
        })
      );
    supply(t, table([me]));
    await assert.rejects(records.reserveStartup('over'), /slots are held/);
  });

  it('pauses on an unknown durable source', async (t) => {
    await reset();
    await fs.writeFile(
      path.join(paths.STARTUPS_DIR, 'future.json'),
      JSON.stringify({
        schema: 1,
        id: 'future',
        admittedAt: Date.now(),
        owner: { pid: 50, startedAt: 1, startSource: 'win32-dmtf-v1', generation: 'f' },
        phase: 'reserved'
      })
    );
    supply(t, table([me]));
    await assert.rejects(records.reserveStartup('after-future'), /Unsupported startup record/);
  });

  it('recovers a dead Windows lock but not a legacy one it cannot judge', async (t) => {
    await reset();
    const lock = path.join(paths.STARTUPS_DIR, 'admission.lock');
    supply(t, table([me]));
    const mine = { pid: HOST, startedAt: 5000, startSource: WIN, generation: 'me' };
    await fs.writeFile(
      lock,
      JSON.stringify({ pid: 50, startedAt: 1, startSource: WIN, generation: 'dead' })
    );
    assert.equal(await ownerClaim.claim(lock, mine), undefined);
    await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
    await fs.writeFile(lock, JSON.stringify({ pid: 50, startedAt: 1, generation: 'legacy' }));
    await assert.rejects(ownerClaim.claim(lock, mine), /another process clock/);
    assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).generation, 'legacy');
  });

  it('keeps a temporary whose writer is on another clock', async (t) => {
    await reset();
    const name = 'admission.lock.legacy.tmp';
    const file = path.join(paths.STARTUPS_DIR, name);
    await fs.writeFile(file, JSON.stringify({ pid: 50, startedAt: 1, generation: 'legacy' }));
    await fs.utimes(file, new Date(0), new Date(0));
    supply(t, table([me]));
    await records.pruneStartupRecords();
    assert.deepEqual(await fs.readdir(paths.STARTUPS_DIR), [name]);
  });
});

describe('Step 4 review: Claude discovery dispatches on the table clock', () => {
  const ms = 1_792_931_583_813;

  async function discovered(t: TestContext, procStart: unknown, at: scan.ProcessTable) {
    const discover = await import('../../core/claude/discover');
    supply(t, at);
    const file = path.join(home, '.claude', 'sessions', '100.json');
    try {
      await helpers.writeJson(file, {
        pid: 100,
        sessionId: 'clock',
        entrypoint: 'sdk-cli',
        cwd: home,
        procStart
      });
      return (await discover.discover()).map((session) => session.pid);
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  it('refuses a POSIX date on a Windows table at, inside and outside the old tolerance', async (t) => {
    const windows = table([row(100, 10, ms, 'node.exe')]);
    for (const offset of [0, 500, 1_900, 2_500, -1_500])
      assert.deepEqual(
        await discovered(t, helpers.utcProcStart(ms + offset), windows),
        [],
        String(offset)
      );
    // Even a table-named claude.exe needs its FILETIME on Windows.
    const named = table([row(100, 10, ms, 'claude.exe')]);
    assert.deepEqual(await discovered(t, helpers.utcProcStart(ms), named), []);
  });

  it('keeps the ps lstart date path and its name rule', async (t) => {
    assert.deepEqual(
      await discovered(t, helpers.utcProcStart(ms), table([row(100, 10, ms, 'node')], PS)),
      [100]
    );
    const named: processes.Row = { pid: 100, ppid: 10, startedAt: ms, command: 'claude -p' };
    assert.deepEqual(await discovered(t, undefined, table([named], PS)), [100]);
  });

  it('refuses every proof on an unrecognized table source', async (t) => {
    const ticks = (EPOCH + BigInt(ms) * 10_000n).toString();
    const named: processes.Row = { pid: 100, ppid: 10, startedAt: ms, command: 'claude -p' };
    const unknown = {
      ...table([named], PS),
      startSource: 'future-clock'
    } as unknown as scan.ProcessTable;
    for (const procStart of [ticks, helpers.utcProcStart(ms), undefined])
      assert.deepEqual(await discovered(t, procStart, unknown), [], String(procStart));
  });
});

describe('Step 4 review: judge needs complete recognized evidence', () => {
  let ownerClaim: typeof import('../../core/coordination/owner_claim');
  before(async () => {
    ownerClaim = await import('../../core/coordination/owner_claim');
  });
  const record = { pid: 50, startedAt: 1, startSource: WIN };
  const future = { ...record, startSource: 'future-clock' } as never;

  it('is unknown on incomplete, failed, unsupported or unrecognized evidence', () => {
    assert.equal(ownerClaim.judge(table([row(51, 1, 1, 'x.exe')], WIN, false), record), 'unknown');
    assert.equal(ownerClaim.judge(table([row(50, 1, 1, 'x.exe')], WIN, false), record), 'unknown');
    const failed = scan.tableOf({ supported: true, status: 'failed', reason: 'x' });
    assert.equal(ownerClaim.judge(failed, record), 'unknown');
    assert.equal(
      ownerClaim.judge(scan.tableOf({ supported: false, reason: 'x' }), record),
      'unknown'
    );
    const clock = { ...table([]), startSource: 'future-clock' } as unknown as scan.ProcessTable;
    assert.equal(ownerClaim.judge(clock, future), 'unknown');
    assert.equal(ownerClaim.judge(table([]), future), 'unknown');
    assert.equal(ownerClaim.judge(table([]), { pid: 1, startedAt: 1 }), 'unknown');
  });

  it('is live or gone only on a complete table on the record’s clock', () => {
    assert.equal(ownerClaim.judge(table([row(50, 1, 1, 'x.exe')]), record), 'live');
    assert.equal(ownerClaim.judge(table([row(50, 1, 2, 'x.exe')]), record), 'gone');
    assert.equal(ownerClaim.judge(table([]), record), 'gone');
    assert.equal(ownerClaim.judge(table([], PS), record), 'unknown');
  });
});

describe('Step 4 review: remote holder metadata', () => {
  async function write(holderFile: Record<string, unknown>): Promise<string> {
    const text = JSON.stringify(holderFile);
    await fs.mkdir(paths.REMOTE_DIR, { recursive: true });
    await fs.writeFile(paths.HOLDER_FILE, text);
    return text;
  }
  const base = { windowId: 'w-dead', label: 'dead', pid: 50, startedAt: 1, since: 0 };
  const host = { ...hostOf(), pid: 50, osStartedAt: 1, windowId: 'w-dead' };
  const me = { windowId: 'w-me', label: 'me', pid: HOST, startedAt: 5000, since: 0 };
  const invalid: Array<[string, unknown]> = [
    ['an unknown clock', { host: { ...host, startSource: 'future-clock' }, generation: 1 }],
    ['a host other than the holder', { host: { ...host, pid: 51 }, generation: 1 }],
    ['malformed metadata', { generation: 1 }]
  ];

  for (const [name, metadata] of invalid)
    it(`never takes over or downgrades a holder with ${name}`, async (t) => {
      const holder = await import('../../core/remote/holder');
      const text = await write({ ...base, incoming: metadata });
      try {
        supply(t, table([row(HOST, 1, 5000, 'code.exe')]));
        assert.equal(await holder.incomingHolderNow('w-dead', undefined), undefined);
        const acquired = await holder.acquireHolder(
          me,
          table([row(HOST, 1, 5000, 'code.exe')]),
          []
        );
        assert.equal(acquired.ok, false);
        assert.equal(await fs.readFile(paths.HOLDER_FILE, 'utf8'), text);
      } finally {
        await fs.rm(paths.HOLDER_FILE, { force: true });
      }
    });

  it('still takes over a dead legacy holder with no incoming metadata', async () => {
    const holder = await import('../../core/remote/holder');
    await write(base);
    try {
      const acquired = await holder.acquireHolder(me, table([row(HOST, 1, 5000, 'code.exe')]), []);
      assert.equal(acquired.ok, true);
    } finally {
      await fs.rm(paths.HOLDER_FILE, { force: true });
    }
  });
});

describe('Step 4 review: remembered member sources', () => {
  let records: typeof import('../../core/coordination/startup_records');
  before(async () => {
    records = await import('../../core/coordination/startup_records');
  });
  const me = row(HOST, 1, 5000, 'code.exe');

  it('keeps an agreeing explicit source and refuses a contradictory one', async (t) => {
    await fs.rm(paths.STARTUPS_DIR, { recursive: true, force: true });
    await fs.mkdir(paths.STARTUPS_DIR, { recursive: true });
    supply(t, table([me]));
    const slot = await records.reserveStartup('explicit');
    await slot.remember([
      { pid: 61, startedAt: 6100, startSource: WIN },
      { pid: 62, startedAt: 6200 }
    ]);
    await assert.rejects(slot.remember([{ pid: 63, startedAt: 6300, startSource: PS }]), /clock/);
    await assert.rejects(
      slot.remember([{ pid: 64, startedAt: 6400, startSource: 'future-clock' } as never]),
      /clock/
    );
    const raw = JSON.parse(
      await fs.readFile(path.join(paths.STARTUPS_DIR, 'explicit.json'), 'utf8')
    ) as { members: unknown[] };
    assert.deepEqual(raw.members, [
      { pid: 61, startedAt: 6100, startSource: WIN },
      { pid: 62, startedAt: 6200, startSource: WIN }
    ]);
    await slot.release();
  });
});

describe('Step 4 review: usage coordination identity', () => {
  let usage: typeof import('../../core/coordination/usage');
  before(async () => {
    usage = await import('../../core/coordination/usage');
  });
  const me = row(HOST, 1, 5000, 'code.exe');
  const brand = 'codex' as const;

  async function reset(): Promise<string> {
    const file = paths.usageStateFile(brand);
    await fs.rm(path.dirname(file), { recursive: true, force: true });
    await fs.mkdir(path.dirname(file), { recursive: true });
    return file;
  }

  async function state(file: string, attempt: Record<string, unknown>): Promise<void> {
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, generation: 'g', notBefore: 0, attempt })
    );
  }

  it('tags a new owner, its lock and its remembered members with the table source', async (t) => {
    const file = await reset();
    supply(t, table([me]));
    const lock = await usage.mutate(
      brand,
      undefined,
      async () =>
        JSON.parse(await fs.readFile(`${file}.lock`, 'utf8')) as {
          startSource?: string;
          startedAt?: number;
        }
    );
    assert.equal(lock.startSource, WIN);
    assert.equal(lock.startedAt, 5000);
    const attempt = await usage.admit(brand, undefined, Date.now());
    assert.ok(attempt);
    await usage.remember(brand, undefined, attempt, [{ pid: 61, startedAt: 6100 }]);
    const saved = (await usage.readState(brand))?.attempt;
    assert.equal(saved?.owner.startSource, WIN);
    assert.deepEqual(saved?.members, [{ pid: 61, startedAt: 6100, startSource: WIN }]);
    await assert.rejects(
      usage.remember(brand, undefined, attempt, [
        { pid: 62, startedAt: 6200, startSource: PS }
      ] as never),
      /clock/
    );
  });

  it('recovers a dead Windows lock and a dead Windows attempt', async (t) => {
    const file = await reset();
    await fs.writeFile(
      `${file}.lock`,
      JSON.stringify({ pid: 50, startedAt: 1, startSource: WIN, generation: 'dead' })
    );
    await state(file, {
      id: 'dead',
      generation: 'g',
      owner: { pid: 50, startedAt: 1, startSource: WIN, generation: 'dead' },
      members: [{ pid: 51, startedAt: 2, startSource: WIN }]
    });
    supply(t, table([me]));
    assert.equal(await usage.admit(brand, undefined, Date.now()), undefined);
    assert.equal((await usage.readState(brand))?.attempt, undefined);
  });

  it('waits for a live owner on another host instead of taking its lock', async (t) => {
    const file = await reset();
    const other = JSON.stringify({ pid: 77, startedAt: 7000, startSource: WIN, generation: 'o' });
    await fs.writeFile(`${file}.lock`, other);
    supply(t, table([me, row(77, 1, 7000, 'code.exe')]));
    await assert.rejects(usage.admit(brand, undefined, Date.now()), /busy/);
    assert.equal(await fs.readFile(`${file}.lock`, 'utf8'), other);
  });

  it('retains attempts it cannot judge on Windows evidence', async (t) => {
    const file = await reset();
    const legacy = {
      id: 'legacy',
      generation: 'g',
      owner: { pid: 50, startedAt: 1, generation: 'legacy' },
      members: []
    };
    await state(file, legacy);
    supply(t, table([me]));
    assert.equal(await usage.admit(brand, undefined, Date.now()), undefined);
    const kept = (await usage.readState(brand))?.attempt;
    assert.deepEqual(kept?.owner, legacy.owner);
    assert.equal(kept?.id, 'legacy');
    // A dead Windows owner whose member is on another clock is not proved gone.
    await state(file, {
      ...legacy,
      id: 'foreign',
      owner: { ...legacy.owner, startSource: WIN },
      members: [{ pid: 51, startedAt: 2 }]
    });
    assert.equal(await usage.admit(brand, undefined, Date.now()), undefined);
    assert.equal((await usage.readState(brand))?.attempt?.id, 'foreign');
  });

  it('refuses an unknown member source', async () => {
    const file = await reset();
    await state(file, {
      id: 'future',
      generation: 'g',
      owner: { pid: 50, startedAt: 1, startSource: WIN, generation: 'f' },
      members: [{ pid: 51, startedAt: 2, startSource: 'future-clock' }]
    });
    await assert.rejects(usage.readState(brand), /Unreadable usage attempt ownership/);
  });
});

describe('Step 4 review: refusal matrices', () => {
  let records: typeof import('../../core/coordination/startup_records');
  before(async () => {
    records = await import('../../core/coordination/startup_records');
  });
  const me = row(HOST, 1, 5000, 'code.exe');
  const owner = { pid: 50, startedAt: 1, startSource: WIN, generation: 'm' };

  for (const [name, fields] of [
    ['child', { phase: 'spawned', child: { pid: 51, startedAt: 2, startSource: 'future-clock' } }],
    ['child', { phase: 'spawned', child: { pid: 51, startedAt: 2, startSource: null } }],
    [
      'member',
      {
        phase: 'spawned',
        child: { pid: 51, startedAt: 2, startSource: WIN },
        members: [{ pid: 52, startedAt: 3, startSource: 'future-clock' }]
      }
    ]
  ] as const)
    it(`pauses starts on a receipt whose ${name} names an unknown clock`, async (t) => {
      await fs.rm(paths.STARTUPS_DIR, { recursive: true, force: true });
      await fs.mkdir(paths.STARTUPS_DIR, { recursive: true });
      const text = JSON.stringify({ schema: 1, id: 'm', admittedAt: Date.now(), owner, ...fields });
      await fs.writeFile(path.join(paths.STARTUPS_DIR, 'm.json'), text);
      supply(t, table([me]));
      await assert.rejects(records.reserveStartup('after-matrix'), /Unsupported startup record/);
      assert.equal(await fs.readFile(path.join(paths.STARTUPS_DIR, 'm.json'), 'utf8'), text);
    });

  it('captures nothing from a failed or unknown-source scan', async (t) => {
    const owned = await import('../../core/owned_incoming');
    const transport = { pid: 20, processAlive: () => true } as unknown as SessionTransport;
    const session = {
      state: { cwd, sessionId: 'current' },
      onChange: () => () => undefined
    } as unknown as SessionHandle;
    const rows = [row(HOST, 1, 1000, 'code.exe'), row(20, HOST, 2000, 'claude.exe')];
    const unknown = { ...table(rows), startSource: 'future-clock' } as unknown as scan.ProcessTable;
    const failed = scan.tableOf({ supported: true, status: 'failed', reason: 'x' });
    for (const evidence of [failed, unknown]) {
      t.mock.restoreAll();
      supply(t, evidence);
      const host = new owned.IncomingHost('w-win');
      assert.equal(await host.capture(transport, session, 'claude', () => true), undefined);
      assert.equal(await host.capability(), undefined);
    }
  });
});
