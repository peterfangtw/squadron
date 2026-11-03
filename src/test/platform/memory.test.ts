import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it, mock } from 'node:test';
import * as platform from '../../core/platform';
import * as memory from '../../core/platform/memory';
import * as darwin from '../../core/platform/memory/darwin';
import * as linux from '../../core/platform/memory/linux';
import * as win32 from '../../core/platform/memory/win32';
import * as machine from '../../core/machine';
import { repoRoot } from '../helpers';

const GIB = 1024 ** 3;
const TOTAL = 25769803776;
let VMSTAT: string;
before(async () => {
  VMSTAT = await fs.readFile(
    path.join(repoRoot(), 'src/test/platform/fixtures/darwin/vm_stat.txt'),
    'utf8'
  );
});

async function value(reader: memory.Memory): Promise<memory.Reading | undefined> {
  const result = await reader.read();
  assert.ok(result.supported && result.status === 'ok', JSON.stringify(result));
  return result.value;
}

function vmStat(text: string, total: number): Promise<memory.Reading | undefined> {
  return value(darwin.memory({ run: () => Promise.resolve(text), totalmem: () => total }));
}

function memInfo(text: string): Promise<memory.Reading | undefined> {
  return value(
    linux.memory({
      readText: (file) =>
        file === '/proc/meminfo' ? Promise.resolve(text) : Promise.reject(new Error('no cgroup'))
    })
  );
}

function cgroup(max: string, current: string): Promise<memory.Reading | undefined> {
  return value(
    linux.memory({
      readText: (file) =>
        Promise.resolve(
          file === '/sys/fs/cgroup/memory.max'
            ? max
            : file === '/sys/fs/cgroup/memory.current'
              ? current
              : ''
        )
    })
  );
}

describe('parseVmStat', () => {
  it('sums app memory, wired and compressed — Activity Monitor’s Memory Used', async () => {
    // (720835 anonymous − 10964 purgeable) + 203095 wired + 280164 compressed,
    // times the 16 KiB page. Spelled out so a failure names the term that moved.
    const used = (720835 - 10964 + 203095 + 280164) * 16384;
    assert.deepEqual(await vmStat(VMSTAT, TOTAL), { used, total: TOTAL });
    assert.equal(used, 19548241920);
    assert.equal((used / GIB).toFixed(1), '18.2');
  });

  it('subtracts purgeable from anonymous, which is what makes it App Memory', async () => {
    const withoutPurgeable = (720835 + 203095 + 280164) * 16384;
    const parsed = await vmStat(VMSTAT, TOTAL);
    assert.equal(withoutPurgeable - (parsed?.used ?? 0), 10964 * 16384);
  });

  it('is not the age-cut sum, which is the mistake this replaced', async () => {
    // `vm_stat` partitions the same pages twice — by age (active/inactive/
    // speculative) and by kind (anonymous/file-backed). Proof they are one set:
    assert.equal(493024 + 495457 + 212, 720835 + 267858);
    // So summing wired + *active* + compressed counts active file cache as used
    // and drops inactive app memory. It shipped once, reading 3.31 GiB low
    // against Activity Monitor. If this assertion ever fails, that is back.
    const ageCut = (203095 + 493024 + 280164) * 16384;
    const parsed = await vmStat(VMSTAT, TOTAL);
    assert.ok(
      (parsed?.used ?? 0) - ageCut > 3 * GIB,
      'the reading collapsed back onto the age cut'
    );
  });

  it('reads the page size rather than assuming Apple silicon', async () => {
    // 4 KiB is what an Intel Mac reports, and the header states it.
    const intel = VMSTAT.replace('page size of 16384 bytes', 'page size of 4096 bytes');
    assert.equal((await vmStat(intel, TOTAL))?.used, (720835 - 10964 + 203095 + 280164) * 4096);
  });

  it('says nothing at all when a row it needs is missing', async () => {
    // A partial table summed as though it were whole is the one failure mode
    // that still paints a believable dial.
    assert.equal(await vmStat(VMSTAT.replace(/^Anonymous pages:.*\n/m, ''), TOTAL), undefined);
    assert.equal(await vmStat(VMSTAT.replace(/^Pages purgeable:.*\n/m, ''), TOTAL), undefined);
  });

  it('says nothing when the header it takes the page size from is gone', async () => {
    assert.equal(await vmStat(VMSTAT.split('\n').slice(1).join('\n'), TOTAL), undefined);
  });

  it('refuses a reading larger than the machine it is a share of', async () => {
    // Not reachable from a healthy table — but a header parsed off the wrong
    // line would paint `30.0G` under a tooltip reading "of 24.0G installed".
    assert.equal(await vmStat(VMSTAT, 8 * GIB), undefined);
  });
});

/** `/proc/meminfo`, trimmed to the fields that matter plus one that does not. */
const MEMINFO = `MemTotal:       16344256 kB
MemFree:          812340 kB
MemAvailable:    9876543 kB
Buffers:          204800 kB
Cached:          6291456 kB
`;

describe('parseMemInfo', () => {
  it('spends what MemAvailable says is left, in bytes', async () => {
    assert.deepEqual(await memInfo(MEMINFO), {
      used: (16344256 - 9876543) * 1024,
      total: 16344256 * 1024
    });
  });

  it('never falls back to MemFree, which would be the macOS lie again', async () => {
    // MemFree is present in this fixture and is a far smaller number. A parser
    // that reached for it would report 95% spent instead of 40%.
    assert.equal(await memInfo(MEMINFO.replace(/^MemAvailable:.*\n/m, '')), undefined);
  });

  it('says nothing without a total', async () => {
    assert.equal(await memInfo(MEMINFO.replace(/^MemTotal:.*\n/m, '')), undefined);
  });

  it('refuses a file claiming more available than installed', async () => {
    assert.equal(await memInfo(MEMINFO.replace('9876543', '99876543')), undefined);
  });
});

describe('parseCgroup', () => {
  it('reads a container’s own ceiling, not the machine it runs on', async () => {
    assert.deepEqual(await cgroup('4294967296\n', '1073741824\n'), {
      used: 1073741824,
      total: 4294967296
    });
  });

  it('declines an uncapped cgroup, whose limit is the word max', async () => {
    // Which is what sends the linux arm on to /proc/meminfo, where the host's
    // figure is the right one.
    assert.equal(await cgroup('max\n', '1073741824\n'), undefined);
  });

  it('declines figures that cannot both be true', async () => {
    assert.equal(await cgroup('1073741824', '4294967296'), undefined);
    assert.equal(await cgroup('0', '0'), undefined);
  });
});

describe('readMemory', () => {
  it('says nothing on a platform we have nothing honest to say about', async () => {
    const result = await memory.refused('aix').read();
    assert.equal(result.supported, false);
    assert.match(!result.supported ? result.reason : '', /memory.read.*aix/);
  });

  it('reads this machine, whichever of the three arms that is', async () => {
    // The one case here that touches the real OS, in the spirit of the
    // `cpuSample` case above: the parsers are checked against fixtures, and
    // this checks that the fetch half reaches something at all.
    const reading = await value(platform.memory);
    assert.ok(reading, 'no reading on a platform the table covers');
    assert.ok(reading.total > 0, 'a machine with no memory');
    assert.ok(reading.used > 0 && reading.used <= reading.total, 'used outran installed');
  });
});

describe('memory acquisition', () => {
  it('runs only vm_stat, with the existing 2-second backstop', async () => {
    const calls: unknown[] = [];
    const reader = darwin.memory({
      run(file, options) {
        calls.push([file, options]);
        return Promise.resolve(VMSTAT);
      },
      totalmem: () => TOTAL
    });
    assert.deepEqual(await value(reader), { used: 19548241920, total: TOTAL });
    assert.deepEqual(calls, [['/usr/bin/vm_stat', { timeout: 2000 }]]);
  });

  it('keeps a capped container off the host meminfo, and falls back only without a reading', async () => {
    for (const max of ['4294967296\n', 'max\n', '0', 'missing']) {
      const calls: string[] = [];
      const reader = linux.memory({
        readText(file) {
          calls.push(file);
          if (file === '/sys/fs/cgroup/memory.max') {
            return max === 'missing' ? Promise.reject(new Error('ENOENT')) : Promise.resolve(max);
          }
          return Promise.resolve(
            file === '/sys/fs/cgroup/memory.current' ? '1073741824\n' : MEMINFO
          );
        }
      });
      const capped = max === '4294967296\n';
      assert.deepEqual(
        await value(reader),
        capped
          ? { used: 1073741824, total: 4294967296 }
          : { used: (16344256 - 9876543) * 1024, total: 16344256 * 1024 }
      );
      assert.deepEqual(calls, [
        '/sys/fs/cgroup/memory.max',
        '/sys/fs/cgroup/memory.current',
        ...(capped ? [] : ['/proc/meminfo'])
      ]);
    }
  });

  it('keeps the Windows counter order and refuses implausible readings without a spawn', async () => {
    for (const [total, free] of [
      [8 * GIB, 3 * GIB],
      [8, 9],
      [0, 0],
      [NaN, 1],
      [8, -1],
      [Infinity, 1]
    ]) {
      const calls: string[] = [];
      const reader = win32.memory({
        totalmem: () => {
          calls.push('total');
          return total!;
        },
        freemem: () => {
          calls.push('free');
          return free!;
        }
      });
      assert.deepEqual(
        await value(reader),
        total === 8 * GIB ? { used: 5 * GIB, total } : undefined
      );
      assert.deepEqual(calls, ['total', 'free', 'total']);
    }
  });

  it('answers command and file failures distinctly, while the machine still shows no memory', async () => {
    const readers = [
      darwin.memory({
        run: () => Promise.reject(new Error('vm_stat timed out')),
        totalmem: () => TOTAL
      }),
      linux.memory({ readText: () => Promise.reject(new Error('unreadable')) }),
      win32.memory({
        totalmem: () => {
          throw new Error('counter failed');
        },
        freemem: () => 0
      })
    ];
    const stub = mock.method(platform.memory, 'read');
    try {
      for (const reader of readers) {
        const result = await reader.read();
        assert.ok(result.supported && result.status === 'failed');
        stub.mock.mockImplementation(() => Promise.resolve(result));
        assert.equal(await machine.readMemory(), undefined);
      }
      stub.mock.mockImplementation(() => memory.refused('aix').read());
      assert.equal(await machine.readMemory(), undefined);
      stub.mock.mockImplementation(() =>
        darwin.memory({ run: () => Promise.resolve(''), totalmem: () => TOTAL }).read()
      );
      assert.equal(await machine.readMemory(), undefined);
      stub.mock.mockImplementation(() =>
        win32.memory({ totalmem: () => 8, freemem: () => 3 }).read()
      );
      assert.deepEqual(await machine.readMemory(), { used: 5, total: 8 });
    } finally {
      stub.mock.restore();
    }
  });
});
