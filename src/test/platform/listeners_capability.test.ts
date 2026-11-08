import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as darwin from '../../core/platform/listeners/darwin';
import * as win32 from '../../core/platform/listeners/win32';
import * as platform from '../../core/platform';
import type { Result } from '../../core/platform/unsupported';
import type { Effects } from '../../core/platform/listeners';
import { listeners } from '../../core/devservers/listeners';
import { testPlatform } from '../helpers';

/**
 * Two halves, for the two ways this can be wrong.
 *
 * The parses are fixtures: `lsof -F` is stateful, and the cases that break a
 * line-independent reading — one process holding two ports, an IPv6 name made of
 * colons, a wildcard bind — are cheaper to state than to arrange. The reading
 * itself is exercised against a real listener in this process, because a stubbed
 * `lsof` would agree with whatever this file believes its output looks like.
 */

const lsofTodo: false | string =
  testPlatform() === 'win32' && 'win32: no lsof reader for cwds or listeners — W7.3';

function value<T>(result: Result<T>): T {
  assert.ok(result.supported);
  assert.equal(result.status, 'ok');
  assert.ok('value' in result);
  return result.value;
}

function rejected(error: unknown): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Fixtures include execFile's untyped rejection shapes.
  return Promise.reject(error);
}

function failed<T>(result: Result<T>): void {
  assert.ok(result.supported);
  assert.equal(result.status, 'failed');
}

async function parseListeners(stdout: string) {
  return value(await darwin.listeners({ run: () => Promise.resolve(stdout) }).read());
}

async function parseCwds(stdout: string) {
  return value(await darwin.listeners({ run: () => Promise.resolve(stdout) }).cwds([7]));
}

describe('parseListeners', () => {
  it('keeps every socket under the process set it was printed in', async () => {
    // The shape a block of dev servers actually produces, and the trap: the
    // `n` lines belong to the `p` line above them. A parse that read the lines
    // independently would give 3001 to whichever pid came last.
    const found = await parseListeners(
      ['p42972', 'cnode', 'f12', 'n*:3000', 'p12470', 'cnode', 'f32', 'n[::1]:3001', ''].join('\n')
    );
    assert.deepEqual(found, [
      { port: 3000, pid: 42972, command: 'node' },
      { port: 3001, pid: 12470, command: 'node' }
    ]);
  });

  it('reads every address form, and one process holding two ports', async () => {
    const found = await parseListeners(
      ['p12700', 'cnode', 'f24', 'n[::1]:63925', 'f25', 'n127.0.0.1:63926', ''].join('\n')
    );
    assert.deepEqual(
      found.map((listener) => listener.port),
      [63925, 63926]
    );
    assert.deepEqual(new Set(found.map((listener) => listener.pid)), new Set([12700]));
  });

  it('does not leak one process set command into the next', async () => {
    // `+c 0` prints a command per set, but nothing promises every set has one —
    // and a remembered `com.docker.backend` on the next pid is a wrong answer
    // that reads as a confident one.
    const found = await parseListeners(
      ['p900', 'ccom.docker.backend', 'f9', 'n*:3000', 'p901', 'f9', 'n*:3001', ''].join('\n')
    );
    assert.deepEqual(found, [
      { port: 3000, pid: 900, command: 'com.docker.backend' },
      { port: 3001, pid: 901 }
    ]);
  });

  it('says nothing for a name that is not a listening port', async () => {
    // A connection rather than a listener, a service name (`lsof` without `-P`),
    // an unparseable pid — and the empty output of an idle block.
    assert.deepEqual(
      await parseListeners(
        [
          'p900',
          'n127.0.0.1:3000->127.0.0.1:51234',
          'p901',
          'nlocalhost:http-alt',
          'pnotapid',
          'n*:3000',
          ''
        ].join('\n')
      ),
      []
    );
    assert.deepEqual(await parseListeners(''), []);
  });
});

describe('failure', () => {
  it('tells a binary that could not be run from one that ran', async () => {
    for (const code of ['ENOENT', 'EACCES']) {
      const tried: string[] = [];
      const reader = darwin.listeners({
        run(file) {
          tried.push(file);
          return tried.length === 1 ? rejected({ code, stdout: '' }) : Promise.resolve('');
        }
      });
      assert.deepEqual(value(await reader.read()), []);
      value(await reader.cwds([7]));
      assert.deepEqual(tried, ['/usr/sbin/lsof', '/usr/bin/lsof', '/usr/bin/lsof']);
    }
  });

  it('tells a killed run from a completed one, whatever stdout it carried', async () => {
    const reader = darwin.listeners({
      run: () =>
        rejected({
          code: null,
          killed: true,
          signal: 'SIGTERM',
          stdout: 'p123\nn*:30000'
        })
    });
    failed(await reader.read());
    failed(await reader.cwds([123]));
    assert.deepEqual(
      value(
        await darwin
          .listeners({
            run: () => rejected({ code: 1, killed: false, stdout: '' })
          })
          .read()
      ),
      []
    );
  });

  it('answers an error of no known shape as failed without throwing', async () => {
    for (const error of [undefined, new Error('boom')]) {
      const reader = darwin.listeners({ run: () => rejected(error) });
      failed(await reader.read());
    }
  });
});

describe('parseCwds', () => {
  it('reads one directory per process', async () => {
    const cwds = await parseCwds(
      [
        'p42972',
        'fcwd',
        'n/Users/x/acme-web/apps/web',
        'p12470',
        'fcwd',
        'n/Users/x/acme-web/apps/site',
        ''
      ].join('\n')
    );
    assert.deepEqual(
      [...cwds],
      [
        [42972, '/Users/x/acme-web/apps/web'],
        [12470, '/Users/x/acme-web/apps/site']
      ]
    );
  });

  it('keeps a directory with spaces in it whole', async () => {
    // A path is whatever the filesystem allows; nothing here may split on one.
    const cwds = await parseCwds(
      ['p7', 'fcwd', 'n/Users/x/My Documents/dev server', ''].join('\n')
    );
    assert.equal(cwds.get(7), '/Users/x/My Documents/dev server');
  });

  it('ignores a name with no process above it', async () => {
    assert.equal((await parseCwds(['fcwd', 'n/tmp', ''].join('\n'))).size, 0);
    assert.equal((await parseCwds('')).size, 0);
  });
});

describe('processCwds', () => {
  it('returns nothing and does not spawn when given no pids', async () => {
    const reader = darwin.listeners({
      run() {
        throw new Error('must not spawn');
      }
    });
    assert.equal(value(await reader.cwds([])).size, 0);
  });

  it('passes every pid in one -p list', async () => {
    const calls: unknown[] = [];
    const reader = darwin.listeners({
      run(file, args, options) {
        calls.push([file, args, options]);
        return Promise.resolve('p42972\nn/tmp/first\np12470\nn/tmp/second\n');
      }
    });
    assert.deepEqual(
      [...value(await reader.cwds([42972, 12470, 13077, 42972]))],
      [
        [42972, '/tmp/first'],
        [12470, '/tmp/second']
      ]
    );
    assert.deepEqual(calls, [
      ['/usr/sbin/lsof', ['-a', '-p', '42972,12470,13077', '-d', 'cwd', '-Fpn'], { timeout: 2000 }]
    ]);
  });

  it('reads every named pid from one -p list', { todo: lsofTodo }, async () => {
    // Two pids, one spawn: `-p` is a comma-joined list, the same shape
    // `listeners()` already uses. One spawn per card is the cost
    // `TASK_done_branch_on_card.md` forbade.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-cwd-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {
      cwd: dir,
      stdio: 'ignore'
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      const pid = child.pid;
      assert.ok(pid);
      const cwds = value(await platform.listeners.cwds([process.pid, pid]));
      assert.equal(
        await fs.realpath(cwds.get(process.pid) ?? ''),
        await fs.realpath(process.cwd())
      );
      assert.equal(await fs.realpath(cwds.get(pid) ?? ''), await fs.realpath(dir));
    } finally {
      child.kill('SIGKILL');
      // win32 will not remove a directory a live process has as its cwd.
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        await once(child, 'exit');
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('listeners', () => {
  /** A real socket in this process, so pid and cwd have known right answers. */
  async function listening(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      // Port 0: the OS picks, so this never collides with a real dev server.
      server.listen(0, () => {
        const address = server.address();
        if (typeof address === 'object' && address) {
          resolve(address.port);
        } else {
          reject(new Error('no port'));
        }
      });
    });
    return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }

  it(
    'names the process behind a bound port, and where it is running',
    { todo: lsofTodo },
    async () => {
      const live = await listening();
      try {
        const mine = (await listeners()).get(live.port);
        assert.equal(mine?.pid, process.pid);
        // The whole point of the second reading: this is the key `servers.ts`
        // records a server under, so attribution is a lookup rather than a guess.
        assert.equal(mine?.cwd, process.cwd());
      } finally {
        await live.close();
      }
    }
  );

  it('says nothing about a port nothing is listening on', async () => {
    // Asked of the port we just released, so it is a port this machine had free
    // a moment ago rather than one hoped to be.
    const live = await listening();
    const port = live.port;
    await live.close();
    assert.equal((await listeners()).get(port), undefined);
  });
});

describe('listener acquisition', () => {
  it('keeps the machine-wide selector and 2-second backstop', async () => {
    const calls: unknown[] = [];
    const reader = darwin.listeners({
      run(file, args, options) {
        calls.push([file, args, options]);
        return Promise.resolve('');
      }
    });
    value(await reader.read());
    assert.deepEqual(calls, [
      ['/usr/sbin/lsof', ['-nP', '+c', '0', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeout: 2000 }]
    ]);
  });

  it('uses the bare fallback last and remembers a completed no-match exit', async () => {
    const tried: string[] = [];
    const reader = darwin.listeners({
      run(file) {
        tried.push(file);
        return rejected(file === 'lsof' ? { code: 1, stdout: '' } : { code: 'ENOENT', stdout: '' });
      }
    });
    assert.deepEqual(value(await reader.read()), []);
    assert.equal(value(await reader.cwds([7])).size, 0);
    assert.deepEqual(tried, ['/usr/sbin/lsof', '/usr/bin/lsof', 'lsof', 'lsof']);
    assert.deepEqual(
      value(
        await darwin
          .listeners({
            run: () => rejected({ code: 2, stdout: 'p7\nn*:3000\n' })
          })
          .read()
      ),
      [{ pid: 7, port: 3000 }]
    );
  });

  it('never parses failed or truncated output, and retries paths after a killed first run', async () => {
    for (const error of [
      { code: 'ENOENT', stdout: '' },
      { code: 'EACCES', stdout: '' },
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'p123\nn*:3000' },
      { code: null, killed: true, stdout: 'p123\nn*:3000' }
    ]) {
      const run: Effects['run'] = () => rejected(error);
      const reader = darwin.listeners({ run });
      failed(await reader.read());
      failed(await reader.cwds([123]));
    }
    const tried: string[] = [];
    const reader = darwin.listeners({
      run(file) {
        tried.push(file);
        return tried.length === 1
          ? rejected({ code: null, killed: true, stdout: 'p123\nn*:3000' })
          : Promise.resolve('');
      }
    });
    failed(await reader.read());
    assert.deepEqual(value(await reader.read()), []);
    assert.deepEqual(tried, ['/usr/sbin/lsof', '/usr/sbin/lsof']);
  });
});

describe('windows listeners', () => {
  const NETSTAT = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4100',
    '  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       4101',
    '  TCP    192.168.1.9:50000      10.0.0.1:443           ESTABLISHED     4102',
    '  TCP    127.0.0.1:50001        127.0.0.1:3000         TIME_WAIT       0',
    '  TCP    [::]:3002              [::]:0                 LISTENING       4103',
    '  TCP    [::1]:5173             [::]:0                 LISTENING       4104',
    '  TCP    [fe80::1%5]:3003       [::]:0                 LISTENING       4105',
    '  UDP    0.0.0.0:5353           *:*                                    4106',
    '  UDP    [::]:5353              *:*                                    4107',
    ''
  ].join('\r\n');

  function reader(run: Effects['run'], windowsDirectory: string | undefined = 'C:\\Windows') {
    return win32.listeners({ run, windowsDirectory });
  }

  it('reads every listening family from the table and nothing else', async () => {
    const found = value(await reader(() => Promise.resolve(NETSTAT)).read());
    assert.deepEqual(found, [
      { port: 3000, pid: 4100 },
      { port: 3001, pid: 4101 },
      { port: 3002, pid: 4103 },
      { port: 5173, pid: 4104 },
      { port: 3003, pid: 4105 }
    ]);
  });

  it('tells a listener by its remote port, never by the state word', async () => {
    const localized = NETSTAT.replaceAll('LISTENING', 'ABHÖREN');
    assert.equal(value(await reader(() => Promise.resolve(localized)).read()).length, 5);
  });

  it('runs the system copy under the backstop, whatever PATH says', async () => {
    const calls: unknown[] = [];
    const answer = await reader((file, args, options) => {
      calls.push([file, args, options]);
      return Promise.resolve('');
    }).read();
    assert.deepEqual(value(answer), []);
    assert.deepEqual(calls, [
      [String.raw`C:\Windows\System32\netstat.exe`, ['-ano'], { timeout: 2000 }]
    ]);
  });

  it('fails the whole read on a table it cannot follow', async () => {
    for (const row of [
      '  TCP    0.0.0.0:notaport       0.0.0.0:0              LISTENING       7',
      '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       many',
      '  TCP    0.0.0.0:3000'
    ]) {
      failed(await reader(() => Promise.resolve(NETSTAT + row + '\r\n')).read());
    }
  });

  it('answers a run that did not finish, or no system directory, as failed', async () => {
    failed(await reader(() => rejected({ killed: true, stdout: NETSTAT })).read());
    for (const directory of ['', 'Windows', String.raw`\\host\share`]) {
      const answer = await reader(() => {
        throw new Error('must not spawn');
      }, directory).read();
      failed(answer);
    }
  });

  it('keeps refusing a directory, which no supported Windows reading gives', async () => {
    const answer = await reader(() => Promise.resolve('')).cwds([123]);
    assert.equal(answer.supported, false);
    assert.ok(!('value' in answer));
  });

  it(
    'finds a real socket under this process on both families',
    { skip: testPlatform() !== 'win32' && 'posix: netstat -ano is the Windows table' },
    async () => {
      for (const host of ['127.0.0.1', '::1']) {
        const server = net.createServer();
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, host, resolve);
        });
        try {
          const address = server.address();
          assert.ok(typeof address === 'object' && address);
          const read = value(await platform.listeners.read());
          assert.ok(read.some((row) => row.port === address.port && row.pid === process.pid));
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      }
    }
  );
});
