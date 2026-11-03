import * as platform from '../../core/platform';
import * as win32 from '../../core/platform/files/win32';
import type { Budget } from '../../core/platform/files';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import { tempHome, writeJson } from '../helpers';
import type { RunningServer } from '../../core/model';

type Servers = typeof import('../../core/devservers/servers');

let home: string;
let servers: Servers;

const dir = () => path.join(home, '.squadron', 'servers');

before(async () => {
  home = await tempHome();
  servers = await import('../../core/devservers/servers');
});

beforeEach(() => fs.rm(dir(), { recursive: true, force: true }));

function server(over: Partial<RunningServer> = {}): RunningServer {
  return {
    cwd: '/repo',
    runnerId: 'dev',
    label: 'npm run dev',
    branch: 'main',
    windowId: 'w1',
    port: 3000,
    status: 'up',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    ...over
  };
}

describe('the running registry', () => {
  it('publishes beat budgets without adding Windows lock waits', async (context) => {
    await servers.writeServer(server());
    let attempts = 0;
    let waits = 0;
    const backend = win32.files({
      stat: () => Promise.reject(new Error('target metadata unavailable')),
      open: () => {
        throw new Error('unexpected directory open');
      },
      rename: () => {
        attempts++;
        return Promise.reject(Object.assign(new Error('locked'), { code: 'EBUSY' }));
      },
      sleep: () => {
        waits++;
        return Promise.resolve();
      }
    });
    const replace = context.mock.method(
      platform.files,
      'replace',
      async (source: string, destination: string, budget: Budget) => {
        assert.deepEqual(budget, { kind: 'beat' });
        await backend.replace(source, destination, budget);
      }
    );
    await servers.writeServer(server());
    await servers.touchServer('/repo', 'dev');
    await servers.keepServer(server());
    await servers.keepServer(server({ cwd: '/missing' }));
    assert.equal(await servers.reviseServer(server()), true);
    assert.equal(attempts, 5);
    assert.equal(replace.mock.callCount(), 5);
    assert.equal(waits, 0);
  });

  it('round-trips a server', async () => {
    await servers.writeServer(server());
    const [read] = await servers.readServers();
    assert.equal(read?.cwd, '/repo');
    assert.equal(read?.port, 3000);
    assert.equal(read?.status, 'up');
  });

  it('lets two runners share one directory', async () => {
    await servers.writeServer(server());
    await servers.writeServer(server({ runnerId: 'storybook', port: 3001 }));

    const read = await servers.readServers();
    assert.deepEqual(read.map((s) => s.runnerId).sort(), ['dev', 'storybook']);
  });

  it('forgets one on stop, and leaves its neighbour alone', async () => {
    await servers.writeServer(server());
    await servers.writeServer(server({ runnerId: 'storybook' }));
    await servers.removeServer('/repo', 'dev');

    assert.deepEqual(
      (await servers.readServers()).map((s) => s.runnerId),
      ['storybook']
    );
  });

  it('takes a stop for a server that was never there', async () => {
    await servers.removeServer('/repo', 'dev');
    assert.deepEqual(await servers.readServers(), []);
  });

  it('drops a stale entry, and takes its file with it', async () => {
    await writeJson(path.join(dir(), 'stale.json'), {
      ...server(),
      updatedAt: Date.now() - servers.SERVER_STALE_MS - 1
    });
    assert.deepEqual(await servers.readServers(), []);
    assert.deepEqual(await fs.readdir(dir()), []);
  });

  it('drops a record with no clock rather than keeping it forever', async () => {
    // The `claims.ts` trap: `Date.now() - undefined` is `NaN`, and every
    // comparison against it is false — so an unswept file is immortal.
    const clockless: Record<string, unknown> = { ...server() };
    delete clockless['updatedAt'];
    await writeJson(path.join(dir(), 'clockless.json'), clockless);
    assert.deepEqual(await servers.readServers(), []);
    assert.deepEqual(await fs.readdir(dir()), []);
  });

  it('skips an unreadable file without losing the others', async () => {
    await servers.writeServer(server());
    await fs.writeFile(path.join(dir(), 'junk.json'), '{ not json');

    assert.deepEqual(
      (await servers.readServers()).map((s) => s.runnerId),
      ['dev']
    );
  });

  // A live record under a name keys no longer give (a win32 lower-drive hash
  // from before keys folded) is not a second server: it is left to go stale.
  it('reads only the file the current key names for a cwd and runner', async () => {
    await writeJson(path.join(dir(), 'ffffffffffffffff.dev.json'), server({ port: 3999 }));
    await servers.writeServer(server());

    assert.deepEqual(
      (await servers.readServers()).map((s) => s.port),
      [3000]
    );
    await fs.access(path.join(dir(), 'ffffffffffffffff.dev.json'));
  });

  it('yields nothing on a machine that has run none', async () => {
    assert.deepEqual(await servers.readServers(), []);
  });
});

describe('the heartbeat', () => {
  it('bumps the clock and nothing else', async () => {
    const written = Date.now() - 5_000;
    await servers.writeServer(server({ status: 'starting', updatedAt: written }));
    await servers.touchServer('/repo', 'dev');

    const [read] = await servers.readServers();
    assert.equal(read?.status, 'starting');
    assert.ok((read?.updatedAt ?? 0) > written, 'the clock moved');
  });

  /**
   * The race this exists for. The poll reads a `starting` record, the readiness
   * probe writes `up` a millisecond later, and the poll's write lands last. A
   * write-back put `starting` over it — and `run` had already returned, so the
   * row stayed amber for a server that was serving, forever.
   */
  it('does not put a stale status back over the readiness result', async () => {
    const stale = server({ status: 'starting' });
    await servers.writeServer(stale);

    // What `run`'s probe does the instant after the poll's read.
    await servers.writeServer({ ...stale, status: 'up', url: 'http://localhost:3000' });
    // What the poll does with the copy it read before that.
    await servers.touchServer(stale.cwd, stale.runnerId);

    const [read] = await servers.readServers();
    assert.equal(read?.status, 'up');
    assert.equal(read?.url, 'http://localhost:3000');
  });

  it('writes nothing for a server that is already gone', async () => {
    await servers.touchServer('/repo', 'dev');
    assert.deepEqual(await servers.readServers(), []);
  });
});

/**
 * A heartbeat that can restore what it was beating for.
 *
 * `touchServer` no-ops on a file that is not there, which is right for a server
 * that has genuinely stopped and wrong for one whose record was swept while it
 * kept serving — a host frozen past `SERVER_STALE_MS` by a sleeping laptop is
 * that case. Without this the ticker only narrows the window instead of
 * closing it.
 */
describe('the heartbeat that restores', () => {
  it('bumps the clock of a record that is still there', async () => {
    await servers.writeServer(server({ status: 'up' }));
    // Read back rather than passed in: `writeServer` stamps `updatedAt` itself
    // and discards whatever the caller set, so asserting against the value we
    // handed it would pass with `keepServer` deleted.
    const before = (await servers.readServers())[0]?.updatedAt ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 2));
    await servers.keepServer(server({ status: 'starting' }));

    const [read] = await servers.readServers();
    // The caller's copy is the fallback, never an overwrite: the same rule
    // `touchServer` keeps, and for the same reason.
    assert.equal(read?.status, 'up', 'the disk won');
    assert.ok((read?.updatedAt ?? 0) > before, 'the clock moved');
  });

  /**
   * A record is one file per `cwd` and `runnerId`, not one per window, so two
   * windows told to start the same thing share it. Beating one that names
   * somebody else made it immortal: the owning window could die and this one
   * would go on saying it was alive, with nothing able to correct it.
   */
  it('leaves another window’s record alone', async () => {
    await servers.writeServer(server({ windowId: 'them', status: 'up' }));
    const before = (await servers.readServers())[0]?.updatedAt ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 2));

    await servers.keepServer(server({ windowId: 'us', status: 'up' }));

    const [read] = await servers.readServers();
    assert.equal(read?.windowId, 'them', 'took over a record it does not own');
    assert.equal(read?.updatedAt, before, 'kept another window’s record alive');
  });

  it('writes the record back when it has been swept', async () => {
    assert.deepEqual(await servers.readServers(), [], 'nothing on disk to start');

    await servers.keepServer(server({ status: 'up', port: 4321 }));

    const [read] = await servers.readServers();
    assert.equal(read?.status, 'up');
    assert.equal(read?.port, 4321);
    assert.equal(read?.cwd, '/repo');
  });
});

/**
 * The keep/remove rule `liveServers` used to own, untestable behind
 * `vscode.env.sessionId`. A poll in the write-before-terminal gap is not
 * something the smoke suite can land.
 */
describe('reconciling a window’s records', () => {
  const NOW = 10_000;
  const ours = (over: Partial<RunningServer> = {}) => server({ windowId: 'us', ...over });
  const them = (over: Partial<RunningServer> = {}) =>
    server({ windowId: 'them', cwd: '/other', runnerId: 'storybook', ...over });

  const decide = (running: RunningServer[], held: readonly RunningServer[] = []) =>
    servers.reconcileServers(running, {
      windowId: 'us',
      holds: (cwd, runnerId) => held.some((h) => h.cwd === cwd && h.runnerId === runnerId),
      now: NOW
    });

  for (const { name, row, isHeld, kept } of [
    {
      name: 'keeps ours that is unheld and still settling',
      row: () => ours({ startedAt: NOW - 1 }),
      isHeld: false,
      kept: true
    },
    {
      name: 'removes ours that is unheld past the settle window',
      row: () => ours({ startedAt: NOW - servers.SERVER_SETTLE_MS }),
      isHeld: false,
      kept: false
    },
    {
      name: 'keeps ours that is held, however old',
      row: () => ours({ startedAt: NOW - 60_000 }),
      isHeld: true,
      kept: true
    },
    {
      name: 'keeps a foreign record even if this window’s hold map names it',
      row: () => them({ startedAt: NOW - 60_000 }),
      isHeld: true,
      kept: true
    },
    {
      name: 'keeps a reservation on the last millisecond of the settle window',
      row: () => ours({ startedAt: NOW - servers.SERVER_SETTLE_MS + 1 }),
      isHeld: false,
      kept: true
    },
    {
      // Refused at the press: there was never a terminal to hold, and the row
      // is the only place the reader hears why. Staleness sweeps it on read.
      name: 'keeps ours that failed on a port already in use, unheld',
      row: () => ours({ startedAt: NOW - 60_000, status: 'failed', reason: servers.IN_USE }),
      isHeld: false,
      kept: true
    },
    {
      name: 'removes ours that failed for any other reason once its terminal is gone',
      row: () => ours({ startedAt: NOW - 60_000, status: 'failed', reason: 'port taken' }),
      isHeld: false,
      kept: false
    },
    {
      // `now - NaN` is NaN, and `NaN < SERVER_SETTLE_MS` is false — the same
      // comparison `liveServers` used to spell inline.
      name: 'treats a missing start clock as already settled',
      row: () => ours({ startedAt: Number.NaN }),
      isHeld: false,
      kept: false
    }
  ]) {
    it(name, () => {
      const running = [row()];
      const { remove, keep } = decide(running, isHeld ? running : []);
      assert.deepEqual(remove, kept ? [] : running);
      assert.deepEqual(keep, kept ? running : []);
    });
  }

  // What the board draws of the records kept: a terminal this window holds,
  // or a start it refused at the press, which never had one.
  for (const { name, row, isHeld, drawn } of [
    { name: 'draws ours that it holds', row: () => ours(), isHeld: true, drawn: true },
    {
      name: 'draws ours refused at the press, holding nothing',
      row: () => ours({ status: 'failed', reason: servers.IN_USE }),
      isHeld: false,
      drawn: true
    },
    {
      name: 'draws no foreign record refused at the press',
      row: () => them({ status: 'failed', reason: servers.IN_USE }),
      isHeld: false,
      drawn: false
    },
    {
      name: 'draws no settling reservation it does not hold yet',
      row: () => ours({ startedAt: NOW - 1 }),
      isHeld: false,
      drawn: false
    }
  ]) {
    it(name, () => {
      const server = row();
      const holds = (cwd: string, runnerId: string) =>
        isHeld && cwd === server.cwd && runnerId === server.runnerId;
      assert.equal(servers.drawnHere(server, { windowId: 'us', holds }), drawn);
    });
  }

  it('keeps a foreign record beside a dead one of ours, in read order', () => {
    const dead = ours({ startedAt: NOW - servers.SERVER_SETTLE_MS });
    const other = them({ startedAt: NOW - servers.SERVER_SETTLE_MS });
    const { remove, keep } = decide([dead, other]);
    assert.deepEqual(remove, [dead]);
    assert.deepEqual(keep, [other]);
  });
});

/**
 * The liveness rule the heartbeat applies, split out of `touchHeldServers` for
 * the reason `reconcileServers` above was: the host half is a `setInterval` and
 * a terminal map, and neither is something a test can stand up. Why the port is
 * asked at all, and why these records and not others: `probeable`.
 */
describe('judging a held server still serving', () => {
  const dead = (over: Partial<RunningServer> = {}) =>
    server({ status: 'failed', reason: 'stopped', ...over });

  for (const { name, row, asked } of [
    {
      name: 'asks a running server with a port',
      row: () => server({ status: 'up', port: 3000 }),
      asked: true
    },
    {
      name: 'leaves a starting server to the readiness probe',
      row: () => server({ status: 'starting', port: 3000 }),
      asked: false
    },
    {
      // The terminal is left open, so re-running the fixed build in it is the
      // reader's obvious next move — and a verdict nothing revisits would say
      // `Run · stopped` over the server they just brought back.
      name: 'keeps asking one it called dead itself',
      row: () => dead(),
      asked: true
    },
    {
      // That record never saw its port answer. A listener on it now is more
      // likely somebody else's than a return of ours.
      name: 'lets a port-taken failure lie',
      row: () => server({ status: 'failed', reason: 'port taken', port: 3000 }),
      asked: false
    },
    {
      name: 'has nothing to ask of a portless runner',
      row: () => server({ status: 'up', port: undefined }),
      asked: false
    }
  ]) {
    it(name, () => {
      assert.equal(servers.probeable(row()), asked);
    });
  }

  it('writes nothing while a running server keeps answering', () => {
    assert.deepEqual(servers.judgeServer(server({ status: 'up' }), true, 0), { misses: 0 });
  });

  it('lets one silent probe pass', () => {
    const { misses, next } = servers.judgeServer(server({ status: 'up' }), false, 0);
    assert.equal(misses, 1);
    assert.equal(next, undefined, 'wrote a verdict on the first miss');
  });

  it('calls it dead on the second, in the word the chip prints', () => {
    const { misses, next } = servers.judgeServer(server({ status: 'up' }), false, 1);
    assert.equal(misses, 2);
    assert.equal(next?.status, 'failed');
    assert.equal(next?.reason, 'stopped');
  });

  it('forgives a miss the next probe answers', () => {
    const { misses, next } = servers.judgeServer(server({ status: 'up' }), true, 1);
    assert.equal(misses, 0);
    assert.equal(next, undefined);
  });

  it('needs the misses consecutive', () => {
    const { misses } = servers.judgeServer(
      server({ status: 'up' }),
      true,
      servers.DEAD_AFTER_MISSES - 1
    );
    assert.equal(servers.judgeServer(server({ status: 'up' }), false, misses).next, undefined);
  });

  it('brings one back when its port answers again, and drops the word with it', () => {
    const { next } = servers.judgeServer(dead(), true, 0);
    assert.equal(next?.status, 'up');
    assert.equal(next?.reason, undefined, 'left `stopped` on a green chip');
  });

  it('leaves a dead one dead while its port stays silent', () => {
    assert.deepEqual(servers.judgeServer(dead(), false, 0), { misses: 0 });
  });
});

/**
 * The heartbeat's write, which is the one write here that may be refused.
 * `keepServer` above covers the same windowId rule for the payload-free case.
 */
describe('revising a record the heartbeat still owns', () => {
  it('writes over our own', async () => {
    await servers.writeServer(server({ status: 'up' }));
    assert.equal(await servers.reviseServer(server({ status: 'failed', reason: 'stopped' })), true);

    const [read] = await servers.readServers();
    assert.equal(read?.status, 'failed');
    assert.equal(read?.reason, 'stopped');
  });

  it('refuses one another window is holding', async () => {
    await servers.writeServer(server({ windowId: 'them', status: 'up' }));
    assert.equal(await servers.reviseServer(server({ windowId: 'us', status: 'failed' })), false);

    const [read] = await servers.readServers();
    assert.equal(read?.status, 'up', 'called another window’s live server dead');
    assert.equal(read?.windowId, 'them');
  });

  it('refuses one that is gone, rather than resurrecting it', async () => {
    // A stop that landed while the probe was in flight. Putting the record
    // back would hold its port in every other window's picker for the length
    // of the staleness sweep, with no window left to correct it.
    assert.equal(await servers.reviseServer(server({ status: 'failed' })), false);
    assert.deepEqual(await servers.readServers(), []);
  });
});
