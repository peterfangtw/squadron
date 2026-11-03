import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { before, describe, it, mock } from 'node:test';
import * as platform from '../../core/platform';
import * as darwin from '../../core/platform/paths/darwin';
import { tempHome } from '../helpers';
import { withFoldedKeys } from '../folded_keys';
import { withWin32Paths } from '../win32_paths';

/**
 * Real listeners on real ports. The whole module exists because of a
 * single-family trap (`docs/tasks/TASK_done_dev_servers.md`), and a test
 * that stubbed `net` would agree with the bug it was written to catch.
 *
 * Imported late, like every other store's test: `paths.ts` resolves `~/.claude`
 * when it is first required.
 */

type Ports = typeof import('../../core/devservers/ports');

let home: string;
let ports: Ports;

const dir = () => path.join(home, '.squadron', 'ports');
const free = (port: number) => ports.free(port);
const occupancy: Ports['occupancy'] = (block, claimed) => ports.occupancy(block, claimed);
const probe = (port: number) => ports.probe(port);

before(async () => {
  home = await tempHome();
  ports = await import('../../core/devservers/ports');
});

/** A listener on one address, closed by the returned function. `undefined` is
 *  node's own default — the wildcard — which is what most servers bind. */
async function listener(host?: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    // Port 0 lets the OS pick, so nothing here collides with a real server.
    server.listen(0, host, () => {
      const address = server.address();
      if (typeof address === 'object' && address) {
        resolve(address.port);
      } else {
        reject(new Error('no port'));
      }
    });
  });
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

describe('free', () => {
  it('says a port bound on ::1 alone is not free', async () => {
    // The regression this module exists for: Vite binds `[::1]` only, and every
    // single-family test calls its port free.
    const live = await listener('::1');
    try {
      assert.equal(await free(live.port), false);
    } finally {
      await live.close();
    }
  });

  it('says a port bound on 127.0.0.1 alone is not free', async () => {
    const live = await listener('127.0.0.1');
    try {
      assert.equal(await free(live.port), false);
    } finally {
      await live.close();
    }
  });

  it('says a port bound on the IPv4 wildcard is not free', async () => {
    // The mirror of the case above, measured 2026-08-04, and the one the
    // loopback pair alone misses: macOS lets a specific address be bound *under*
    // a wildcard listener, so both loopback binds succeed while the port is
    // plainly in use. It is the common shape, too — a default `listen(port)` and
    // any `--host` land here, not on loopback.
    const live = await listener('0.0.0.0');
    try {
      assert.equal(await free(live.port), false);
    } finally {
      await live.close();
    }
  });

  it('says a port bound on the IPv6 wildcard is not free', async () => {
    const live = await listener();
    try {
      assert.equal(await free(live.port), false);
    } finally {
      await live.close();
    }
  });

  it('says a port nothing is listening on is free', async () => {
    const live = await listener('::1');
    const { port } = live;
    await live.close();
    assert.equal(await free(port), true);
  });
});

describe('occupancy', () => {
  it('reports the whole block, port by port', async () => {
    const live = await listener('::1');
    try {
      const block = { base: live.port, span: 3 };
      const status = await occupancy(block);
      assert.deepEqual(
        status.map((s) => s.port),
        [live.port, live.port + 1, live.port + 2]
      );
      assert.equal(status[0]?.free, false);
    } finally {
      await live.close();
    }
  });

  it('marks a reserved-but-unbound port with the branch holding it', async () => {
    const live = await listener('::1');
    const { port } = live;
    await live.close();

    const [status] = await occupancy({ base: port, span: 1 }, new Map([[port, 'side']]));
    assert.equal(status?.free, false);
    assert.equal(status?.heldBy, 'side');
  });

  it('leaves a free port with no holder', async () => {
    const live = await listener('::1');
    const { port } = live;
    await live.close();

    const [status] = await occupancy({ base: port, span: 1 });
    assert.deepEqual(status, { port, free: true });
  });
});

/** The first run of `span` ports from 40100 up that bind free one at a time,
 *  below the ephemeral range so no outbound socket wanders into it. */
async function quietRange(span: number): Promise<number> {
  for (let base = 40100; base < 41000; base += span) {
    let quiet = true;
    for (let port = base; port < base + span && quiet; port++) quiet = await free(port);
    if (quiet) return base;
  }
  return assert.fail('no quiet range of ports on this machine');
}

describe('sheetPorts', () => {
  const start = (key: string, base?: number, span = 10) =>
    base === undefined ? { key } : { key, block: { base, span } };

  it('names each port once, however the blocks overlap', () => {
    const blocks = [start('web', 28120), start('api', 28125)];
    const want = Array.from({ length: 15 }, (_, i) => 28120 + i);
    assert.deepEqual(ports.sheetPorts(blocks, {}), want);
  });

  it('adds a start’s remembered port outside every block, in port order', () => {
    assert.deepEqual(
      ports.sheetPorts([start('site', 4321, 2)], { site: 3000 }),
      [3000, 4321, 4322]
    );
  });

  it('skips a remembered port no block could bind, and one of a start with no block', () => {
    const starts = [start('site', 4321, 1), start('host')];
    assert.deepEqual(ports.sheetPorts(starts, { site: 80, host: 3000 }), [4321]);
    assert.deepEqual(ports.sheetPorts(starts, { site: 4321.5 }), [4321]);
  });
});

describe('occupancyOf', () => {
  // The race a per-block pass had: overlapping ports bound twice at once, each
  // probe's own listener read by the other as a holder.
  it('calls every port of overlapping blocks free when nothing listens', async () => {
    const base = await quietRange(15);
    const blocks = [
      { key: 'web', block: { base, span: 10 } },
      { key: 'api', block: { base: base + 5, span: 10 } }
    ];
    const status = await ports.occupancyOf(ports.sheetPorts(blocks, {}));
    assert.deepEqual(
      status.filter((s) => !s.free).map((s) => s.port),
      []
    );
    assert.equal(status.length, 15);
  });

  it('reports a listener on a typed port as taken, and a claimed one by its holder', async () => {
    const live = await listener();
    try {
      const [taken] = await ports.occupancyOf([live.port]);
      assert.equal(taken?.free, false);
    } finally {
      await live.close();
    }
    const [claimed] = await ports.occupancyOf([live.port], new Map([[live.port, 'side']]));
    assert.deepEqual(claimed, { port: live.port, free: false, heldBy: 'side' });
  });
});

describe('probe', () => {
  it('answers true against a live listener', async () => {
    const live = await listener('::1');
    try {
      assert.equal(await probe(live.port), true);
    } finally {
      await live.close();
    }
  });

  it('answers false against a closed port', async () => {
    const live = await listener('::1');
    const { port } = live;
    await live.close();
    assert.equal(await probe(port), false);
  });
});

describe('rememberKey', () => {
  it('is the bare runner at the tree root', () => {
    assert.equal(ports.rememberKey('/work/app', '/work/app', 'dev'), 'dev');
  });

  it('names the package for a workspace below it', () => {
    assert.equal(ports.rememberKey('/work/app', '/work/app/apps/store', 'dev'), 'apps/store:dev');
    assert.equal(ports.rememberKey('work/app', 'work/app/apps/admin', 'dev'), 'apps/admin:dev');
  });

  it('keeps Windows drive and separator variants in portable keys and runner IDs verbatim', () =>
    withWin32Paths(() => {
      const runner = 'Dev\\Watch:Fast/Raw';
      assert.equal(ports.rememberKey('C:\\x\\Foo', 'c:/x/Foo', runner), runner);
      for (const cwd of ['c:/x/Foo/apps/admin', 'C:\\x\\Foo\\apps\\admin']) {
        assert.equal(ports.rememberKey('C:\\x\\Foo', cwd, runner), `apps/admin:${runner}`);
      }
      assert.equal(ports.rememberKey('\\\\srv\\a', '//srv/a/apps/admin', 'dev'), 'apps/admin:dev');
    }));

  it('falls back for Windows case-distinct, escaping and cross-root paths', () =>
    withWin32Paths(() => {
      for (const cwd of [
        'C:\\x\\foo\\apps\\admin',
        'C:\\x\\Foo2\\apps\\admin',
        'C:\\x\\Foo\\..\\outside',
        'D:\\x\\Foo\\apps\\admin'
      ]) {
        assert.equal(ports.rememberKey('C:\\x\\Foo', cwd, 'dev'), 'dev', cwd);
      }
      assert.equal(ports.rememberKey('\\\\srv\\a', '\\\\srv\\b\\apps\\admin', 'dev'), 'dev');
    }));

  it('preserves literal backslashes in POSIX components and runner IDs', () => {
    const { key, contains } = platform.paths;
    const { sep } = path;
    const resolve = mock.method(path, 'resolve', path.posix.resolve.bind(path.posix));
    const relative = mock.method(path, 'relative', path.posix.relative.bind(path.posix));
    Object.assign(path, { sep: path.posix.sep });
    Object.assign(platform.paths, darwin.paths());
    try {
      const runner = 'Dev\\Watch:Fast/Raw';
      assert.equal(
        ports.rememberKey('/work/app', '/work/app/apps\\admin/web', runner),
        `apps\\admin/web:${runner}`
      );
      assert.equal(ports.rememberKey('/work/app', '/work/app', runner), runner);
      assert.equal(ports.rememberKey('/work/app', '/work/App/web', runner), runner);
      assert.equal(
        ports.rememberKey('work/app', 'work/app/apps\\admin', runner),
        `apps\\admin:${runner}`
      );
    } finally {
      Object.assign(platform.paths, { key, contains });
      Object.assign(path, { sep });
      resolve.mock.restore();
      relative.mock.restore();
    }
  });

  it('tells two apps’ identical scripts apart', () => {
    assert.notEqual(
      ports.rememberKey('/work/app', '/work/app/apps/store', 'dev'),
      ports.rememberKey('/work/app', '/work/app/apps/admin', 'dev')
    );
  });

  it('falls back to the runner rather than writing a path that climbs out', () => {
    assert.equal(ports.rememberKey('/work/app', '/elsewhere/thing', 'dev'), 'dev');
  });
});

describe('the remembered picks', () => {
  it('round-trips a branch’s choice, runner by runner', async () => {
    await ports.rememberPort('/repo/one', 'main', 'dev', 3000);
    await ports.rememberPort('/repo/one', 'main', 'storybook', 3001);
    await ports.rememberPort('/repo/one', 'side', 'dev', 3002);

    const record = await ports.readPorts('/repo/one');
    assert.deepEqual(record.lastUsed, {
      main: { dev: 3000, storybook: 3001 },
      side: { dev: 3002 }
    });
    assert.equal(record.repoRoot, '/repo/one');
  });

  it('finds a repo’s picks, and an app’s key, under another spelling of either', () =>
    withFoldedKeys(async () => {
      const key = ports.rememberKey('/Repo/Six', '/repo/six/apps/Web', 'dev');
      assert.equal(key, 'apps/web:dev');
      assert.equal(ports.rememberKey('/repo/six', '/REPO/SIX/apps/web', 'dev'), key);

      await ports.rememberPort('/Repo/Six', 'main', key, 3000);
      await ports.rememberPort(
        '/Repo/Six',
        'main',
        ports.rememberKey('/Repo/Six', '/Repo/Six', 'dev'),
        3001
      );
      const record = await ports.readPorts('/repo/SIX');
      assert.equal(record.repoRoot, '/repo/SIX');
      assert.equal(
        record.lastUsed['main']?.[ports.rememberKey('/repo/six', '/repo/six/apps/web', 'dev')],
        3000
      );
      assert.equal(
        record.lastUsed['main']?.[ports.rememberKey('/repo/six', '/repo/six', 'dev')],
        3001
      );
      assert.deepEqual(record.lastUsed, { main: { 'apps/web:dev': 3000, dev: 3001 } });
    }));

  it('keeps one repo’s picks out of another’s', async () => {
    await ports.rememberPort('/repo/two', 'main', 'dev', 4000);
    assert.equal((await ports.readPorts('/repo/three')).lastUsed['main'], undefined);
  });

  it('yields no block and no picks for a repo nobody has run', async () => {
    const read = await ports.readPorts('/repo/unseen');
    assert.deepEqual(read, { schema: 1, repoRoot: '/repo/unseen', lastUsed: {} });
    assert.deepEqual(ports.resolveBlock(read), { base: 3000, span: 10 });
  });

  it('honours a block edited by hand', async () => {
    // Emptied first, so the one file left is the repo under test — the store
    // hashes its name, and a test that recomputed the hash would only agree
    // with itself.
    await fs.rm(dir(), { recursive: true, force: true });
    await ports.rememberPort('/repo/four', 'main', 'dev', 3000);
    const names = await fs.readdir(dir());
    assert.equal(names.length, 1, `expected one file, found ${names.join(', ')}`);
    const file = path.join(dir(), names[0] ?? '');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...record, block: { base: 8080, span: 4 } }));

    assert.deepEqual((await ports.readPorts('/repo/four')).block, { base: 8080, span: 4 });

    // A later pick keeps it: the block is the reader's, and the pick rewrites
    // the file around it.
    await ports.rememberPort('/repo/four', 'main', 'dev', 8081);
    const after = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(after.block, { base: 8080, span: 4 });
    assert.equal(after.lastUsed.main.dev, 8081);
  });

  it('writes no block when a pick is all anyone made', async () => {
    await fs.rm(dir(), { recursive: true, force: true });
    await ports.rememberPort('/repo/picked', 'main', 'dev', 3000);
    await ports.rememberPort('/repo/picked', 'main', 'dev', 3001);
    const names = await fs.readdir(dir());
    const record = JSON.parse(await fs.readFile(path.join(dir(), names[0] ?? ''), 'utf8'));
    assert.equal('block' in record, false);
    assert.equal((await ports.readPorts('/repo/picked')).block, undefined);
  });

  it('reads a stored DEFAULT_BLOCK as unset, since a pick wrote it and nobody chose it', async () => {
    await fs.rm(dir(), { recursive: true, force: true });
    await ports.rememberPort('/repo/minted', 'main', 'dev', 3000);
    const names = await fs.readdir(dir());
    const file = path.join(dir(), names[0] ?? '');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...record, block: { base: 3000, span: 10 } }));

    const read = await ports.readPorts('/repo/minted');
    assert.equal(read.block, undefined);
    assert.deepEqual(ports.resolveBlock(read, 4321), { base: 4321, span: 10 });
  });

  it('degrades a malformed file to the default rather than throwing', async () => {
    await fs.rm(dir(), { recursive: true, force: true });
    await ports.rememberPort('/repo/five', 'main', 'dev', 3000);
    const names = await fs.readdir(dir());
    for (const name of names) {
      await fs.writeFile(path.join(dir(), name), '{ not json');
    }
    assert.deepEqual(ports.resolveBlock(await ports.readPorts('/repo/five')), {
      base: 3000,
      span: 10
    });
    assert.deepEqual((await ports.readPorts('/repo/five')).lastUsed, {});
  });

  /**
   * A block outside 0–65535 is the hand-edit that costs the most: `net.listen`
   * throws for it *synchronously*, past the `error` handler `bindable` resolves
   * on, so `free` rejects and every caller up to the run picker rejects with it
   * — a sheet that never fills in and says nothing, on every open.
   */
  it('refuses a block that cannot be bound, rather than one that hangs the picker', async () => {
    const bad = [
      { base: 65530, span: 10 }, // runs off the end of the 16-bit space
      { base: 3000.5, span: 4 }, // not a port at all
      { base: 3000, span: 100_000 }, // an allocation, not a block
      { base: 80, span: 4 } // unbindable unprivileged
    ];
    for (const block of bad) {
      await fs.rm(dir(), { recursive: true, force: true });
      await ports.rememberPort('/repo/bad', 'main', 'dev', 3000);
      const names = await fs.readdir(dir());
      const file = path.join(dir(), names[0] ?? '');
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      await fs.writeFile(file, JSON.stringify({ ...record, block }));

      const read = await ports.readPorts('/repo/bad');
      assert.equal(read.block, undefined, `took ${JSON.stringify(block)}`);
      // The whole point: the picker's own call still answers.
      await assert.doesNotReject(() => ports.occupancy(ports.resolveBlock(read)));
    }
  });

  it('resolves the file’s block over the toolchain’s, and the toolchain’s over the default', () => {
    const bare = { schema: 1 as const, repoRoot: '/repo/r', lastUsed: {} };
    const set = { ...bare, block: { base: 8080, span: 4 } };
    assert.deepEqual(ports.resolveBlock(set, 4321), { base: 8080, span: 4 });
    assert.deepEqual(ports.resolveBlock(bare, 4321), { base: 4321, span: 10 });
    assert.deepEqual(ports.resolveBlock(bare), { base: 3000, span: 10 });
  });

  it('refuses a suggestion no block could bind, since a settings runner can carry any JSON', () => {
    const bare = { schema: 1 as const, repoRoot: '/repo/r', lastUsed: {} };
    // Under the 1024 floor, past the 65536 ceiling, not an integer, not a number.
    for (const suggest of [80, 65530, 4321.5, Number.NaN, '4321' as unknown as number]) {
      assert.deepEqual(
        ports.resolveBlock(bare, suggest),
        { base: 3000, span: 10 },
        `took ${String(suggest)}`
      );
    }
  });

  /** `free` is the belt to `readPorts`' braces: no port value may reject it. */
  it('calls an impossible port unfree instead of throwing out of free()', async () => {
    assert.equal(await free(70_000), false);
    assert.equal(await free(-1), false);
  });

  it('refuses a foreign schema and another repo’s record behind the same name', async () => {
    await fs.rm(dir(), { recursive: true, force: true });
    await ports.rememberPort('/repo/six', 'main', 'dev', 3000);
    const names = await fs.readdir(dir());
    const file = path.join(dir(), names[0] ?? '');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));

    await fs.writeFile(file, JSON.stringify({ ...record, schema: 2 }));
    assert.deepEqual((await ports.readPorts('/repo/six')).lastUsed, {});

    // What a 64-bit prefix collision would look like: the name is ours, the
    // contents are some other repo's.
    await fs.writeFile(file, JSON.stringify({ ...record, repoRoot: '/repo/elsewhere' }));
    assert.deepEqual((await ports.readPorts('/repo/six')).lastUsed, {});
  });
});
