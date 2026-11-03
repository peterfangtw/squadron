import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as platform from '../../core/platform';
import * as runner from '../smoke/runner';
import * as ownership from '../smoke/ownership';
import * as devHost from '../smoke/dev_host';
import * as ide from '../smoke/ide';
import * as registry from '../smoke/scenarios';
import { outRoot, testPlatform } from '../helpers';

const row = (pid: number, ppid = 1, pgid = pid, startedAt = 1000): ownership.ProcessIdentity => ({
  pid,
  ppid,
  pgid,
  startedAt
});

/** A win32 row: no process group, never one made up from the pid. */
const groupless = (pid: number, ppid = 1, startedAt = 1000): ownership.ProcessIdentity => ({
  pid,
  ppid,
  startedAt
});

function rig(rows: ownership.ProcessIdentity[]): {
  launch: ownership.LaunchOwnership;
  ports: ownership.CleanupPorts;
  signals: number[];
  table: Map<number, ownership.ProcessIdentity>;
} {
  const table = new Map(rows.map((p) => [p.pid, p]));
  const signals: number[] = [];
  const launch = ownership.ownLaunch('test', rows[0]!);
  const ports: ownership.CleanupPorts = {
    read: () => Promise.resolve(new Map(table)),
    signal: (member, _signal, group) => {
      const pid = group ? -member.pid : member.pid;
      signals.push(pid);
      if (pid < 0)
        for (const [key, p] of table) {
          if (p.pgid === -pid) table.delete(key);
        }
      else table.delete(pid);
    },
    pause: () => Promise.resolve(),
    now: () => 0
  };
  return { launch, ports, signals, table };
}

describe('smoke ownership', () => {
  it('closes this repository’s dev hosts and children before returning, preserving other IDEs', async () => {
    const r = rig([row(10), row(11, 10), row(20), row(30), row(40)]);
    const commands = new Map([
      [
        10,
        '/Applications/Visual Studio Code.app/Contents/MacOS/Code --extensionDevelopmentPath=/repo with spaces --user-data-dir=/tmp/old'
      ],
      [
        20,
        '/Applications/Visual Studio Code.app/Contents/MacOS/Code --extensionDevelopmentPath=/repo with spaces other --user-data-dir=/tmp/unrelated'
      ],
      [
        30,
        '/bin/zsh -c /Applications/Visual Studio Code.app/Contents/MacOS/Code --extensionDevelopmentPath=/repo with spaces'
      ],
      [40, '/Applications/Visual Studio Code.app/Contents/MacOS/Code --user-data-dir=/tmp/normal']
    ]);
    for (const [pid, command] of commands) Object.assign(r.table.get(pid)!, { command });
    await devHost.closePreviousHosts(['/repo with spaces'], r.ports);
    assert.deepEqual([...r.table.keys()], [20, 30, 40]);
    assert.ok(r.signals.includes(10));
    assert.ok(r.signals.includes(11));
  });

  it('reads process dates independently of the inherited locale', async () => {
    const locale = process.env['LC_ALL'];
    process.env['LC_ALL'] = 'ja_JP.UTF-8';
    try {
      assert.ok((await ownership.readProcesses()).has(process.pid));
    } finally {
      if (locale === undefined) delete process.env['LC_ALL'];
      else process.env['LC_ALL'] = locale;
    }
  });

  it('remembers a separate-group child across reparenting and leader loss', async () => {
    const r = rig([row(10), row(11, 10, 11), row(12, 11, 11)]);
    ownership.observeLaunch(r.launch, r.table);
    r.table.delete(10);
    r.table.delete(11);
    r.table.set(12, row(12, 1, 11));
    await ownership.cleanupLaunch(r.launch, r.ports);
    assert.deepEqual(r.signals, [12]);
    assert.equal(r.launch.closed, true);
  });

  it('never signals a reused PID, changed group or unrelated same-name process', async () => {
    const r = rig([row(10), row(11, 10, 11), row(13, 10, 13), row(99)]);
    ownership.observeLaunch(r.launch, r.table);
    r.table.set(10, row(10, 1, 10, 2000));
    r.table.set(11, row(11, 1, 12));
    await assert.rejects(ownership.cleanupLaunch(r.launch, r.ports), /identity|group/);
    assert.deepEqual(r.signals, [-13]);
    assert.ok(r.table.has(99));
    assert.equal(r.launch.closed, false);
  });

  it('retains uncertainty for an unrecorded member after group leader loss', async () => {
    const r = rig([row(10)]);
    r.table.delete(10);
    r.table.set(12, row(12, 1, 10));
    await assert.rejects(ownership.cleanupLaunch(r.launch, r.ports), /unwitnessed group/);
    assert.deepEqual(r.signals, []);
    assert.equal(r.launch.closed, false);
    r.table.delete(12);
    await ownership.cleanupLaunch(r.launch, r.ports);
    assert.equal(r.launch.closed, true);
  });

  it('shares in-flight cleanup, and retries after scan failure', async () => {
    const r = rig([row(10)]);
    const failed = { ...r.ports, read: () => Promise.reject(new Error('ps failed')) };
    const first = ownership.cleanupLaunch(r.launch, failed);
    assert.equal(ownership.cleanupLaunch(r.launch, failed), first);
    await assert.rejects(first, /ps failed/);
    assert.equal(r.launch.closed, false);
    await ownership.cleanupLaunch(r.launch, r.ports);
    assert.equal(r.launch.closed, true);
  });

  it('reports signal refusal without declaring cleanup complete', async () => {
    const r = rig([row(10)]);
    await assert.rejects(
      ownership.cleanupLaunch(r.launch, {
        ...r.ports,
        signal: () => {
          throw new Error('EPERM');
        }
      }),
      /EPERM/
    );
    assert.equal(r.launch.closed, false);
    await ownership.cleanupLaunch(r.launch, r.ports);
  });

  it('uses only PIDs for a runner that shares the foreground group', async () => {
    const r = rig([row(10, 1, 10), row(11, 10, 10)]);
    r.launch.groups = false;
    await ownership.cleanupLaunch(r.launch, r.ports);
    assert.deepEqual(
      r.signals.sort((a, b) => a - b),
      [10, 11]
    );
  });

  it('reports a groupless dead member’s late children red, never signalling them', async () => {
    // A child seen only through a dead pid may be a reuser's orphan: it and
    // its descendants are retained as suspects, never owned.
    const r = rig([groupless(10, 1, 1000)]);
    assert.equal(r.launch.groups, false);
    r.table.delete(10);
    r.table.set(11, groupless(11, 10, 1500));
    r.table.set(12, groupless(12, 11, 1600));
    r.table.set(14, groupless(14, 10, 900));
    await assert.rejects(
      ownership.cleanupLaunch(r.launch, r.ports),
      /unwitnessed descendants of a dead member survived cleanup: 11@1500,12@1600$/
    );
    assert.deepEqual(r.signals, []);
    assert.equal(r.launch.closed, false);
    assert.ok(r.table.has(11) && r.table.has(12) && r.table.has(14));
    r.table.delete(11);
    r.table.delete(12);
    await ownership.cleanupLaunch(r.launch, r.ports);
    assert.equal(r.launch.closed, true);

    const s = rig([groupless(20, 1, 1000)]);
    s.table.set(20, groupless(20, 1, 3000));
    s.table.set(21, groupless(21, 20, 1500));
    s.table.set(23, groupless(23, 20, 3500));
    await assert.rejects(ownership.cleanupLaunch(s.launch, s.ports), /: 21@1500$/);
    assert.deepEqual(s.signals, []);
    assert.ok(s.table.has(20) && s.table.has(21) && s.table.has(23));
  });

  it('keeps a live edge owned beside a suspect, and lets no later pid take a suspect’s place', async () => {
    const r = rig([groupless(10, 1, 1000), groupless(11, 10, 1100)]);
    ownership.observeLaunch(r.launch, r.table);
    r.table.delete(10);
    r.table.set(15, groupless(15, 10, 1500));
    r.table.set(16, groupless(16, 11, 1600));
    ownership.observeLaunch(r.launch, r.table);
    assert.deepEqual([...r.launch.members.keys()].sort(), [10, 11, 16]);
    assert.deepEqual(
      [...r.launch.suspects.values()].map((p) => p.pid),
      [15]
    );
    // The suspect exits and an unrelated process takes its pid, then its own
    // child: neither is the retained identity, nor a member.
    r.table.set(15, groupless(15, 1, 2000));
    r.table.set(17, groupless(17, 15, 2100));
    await ownership.cleanupLaunch(r.launch, r.ports);
    assert.deepEqual(
      r.signals.sort((a, b) => a - b),
      [11, 16]
    );
    assert.ok(r.table.has(15) && r.table.has(17));
    assert.equal(r.launch.closed, true);
  });

  it('refutes a parent edge whose parent is younger than its child', () => {
    const rows = new Map([
      [10, groupless(10, 1, 3000)],
      [11, groupless(11, 10, 2000)],
      [12, groupless(12, 10, 3500)]
    ]);
    const parents = ownership.parentsOf(rows);
    assert.equal(parents.get(11), undefined);
    assert.equal(parents.get(12), 10);
  });

  it('closes a win32 dev host by its quoted flag and image, sparing every other row', async () => {
    const repo = 'C:\\repo with spaces';
    const ide = process.env['SQUADRON_IDE'];
    process.env['SQUADRON_IDE'] = 'C:\\VS\\Code.exe';
    try {
      const host = (pid: number, ppid: number, image: string, command: string) => ({
        ...groupless(pid, ppid),
        image,
        command
      });
      const r = rig([
        host(
          10,
          1,
          'Code.exe',
          `"C:\\VS\\Code.exe" "--inspect=0" "--extensionDevelopmentPath=${repo}" "--new-window"`
        ),
        host(11, 10, 'Code.exe', `"C:\\VS\\Code.exe" --type=renderer --user-data-dir=C:\\p`),
        host(20, 1, 'Code.exe', `"C:\\VS\\Code.exe" "--extensionDevelopmentPath=${repo} Other"`),
        host(
          30,
          1,
          'cmd.exe',
          `cmd.exe /d /s /c ""C:\\VS\\Code.exe" "--extensionDevelopmentPath=${repo}""`
        ),
        host(40, 1, 'Code.exe', '"C:\\VS\\Code.exe" '),
        host(
          50,
          1,
          'Code.exe',
          `"C:\\VS\\Code.exe" --type=utility "--extensionDevelopmentPath=${repo}"`
        ),
        // A case-sensitive directory can hold this sibling: another worktree.
        host(
          60,
          1,
          'Code.exe',
          `"C:\\VS\\Code.exe" "--extensionDevelopmentPath=C:\\REPO With Spaces"`
        ),
        host(
          70,
          1,
          'CODE.EXE',
          `"C:\\VS\\Code.exe" "--EXTENSIONDEVELOPMENTPATH=c:/repo with spaces"`
        )
      ]);
      await devHost.closePreviousHosts(['c:/repo with spaces'], r.ports);
      assert.deepEqual([...r.table.keys()], [20, 30, 40, 50, 60]);
      assert.deepEqual(
        r.signals.sort((a, b) => a - b),
        [10, 11, 70]
      );
    } finally {
      if (ide === undefined) delete process.env['SQUADRON_IDE'];
      else process.env['SQUADRON_IDE'] = ide;
    }
  });

  it('writes a cmd launcher that doubles percent signs and refuses a quote', () => {
    const text = runner.launcherCmd('C:\\100% node\\node.exe', 'C:\\h\\launcher.js');
    assert.ok(text.includes('"C:\\100%% node\\node.exe" "C:\\h\\launcher.js"\r\n'), text);
    assert.ok(text.endsWith('\r\n') && !/[^\r]\n/.test(text), text);
    assert.throws(() => runner.launcherCmd('C:\\a"b\\node.exe', 'x.js'), /cannot quote/);
  });

  it(
    'runs the cmd launcher as Playwright does: helper first, then the IDE with every argument',
    { skip: testPlatform() !== 'win32' && 'posix: Playwright runs no cmd.exe there' },
    async (t) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-launch-cmd-'));
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const helper = path.join(dir, 'helper.js');
      const ide = path.join(dir, 'ide.js');
      const seen = path.join(dir, 'helper.json');
      await fs.writeFile(
        helper,
        `require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ ppid: process.ppid }));\nprocess.exitCode = Number(process.env.HELPER_EXIT ?? 0);\n`
      );
      await fs.writeFile(ide, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
      const launcher = path.join(dir, 'launch.cmd');
      await fs.writeFile(launcher, runner.launcherCmd(process.execPath, helper));
      const words = [launcher, ide, '--a=b c', 'x&y', '--inspect=0'];
      const run = (exit: string) =>
        new Promise<{ code: number | null; pid: number; out: string }>((resolve, reject) => {
          const child = childProcess.spawn(words.map((word) => `"${word}"`).join(' '), [], {
            shell: true,
            stdio: ['ignore', 'pipe', 'inherit'],
            env: { ...process.env, SQUADRON_SMOKE_IDE: process.execPath, HELPER_EXIT: exit }
          });
          let out = '';
          child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
          child.once('error', reject);
          child.once('close', (code) => resolve({ code, pid: child.pid ?? 0, out }));
        });
      const ok = await run('0');
      assert.equal(ok.code, 0);
      assert.deepEqual(JSON.parse(ok.out), words.slice(2));
      const recorded = JSON.parse(await fs.readFile(seen, 'utf8')) as { ppid: number };
      assert.equal(recorded.ppid, ok.pid);
      const refused = await run('3');
      assert.equal(refused.code, 3);
      assert.equal(refused.out, '');
      // A crashed helper exits with a negative NTSTATUS (access violation,
      // stack overflow), which `if errorlevel 1` reads as success.
      for (const status of ['-1', '-1073741819']) {
        const crashed = await run(status);
        assert.notEqual(crashed.code, 0, status);
        assert.equal(crashed.out, '', status);
      }
    }
  );

  it('reads the host version from either OS bundle layout, and none when two disagree', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-ide-version-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const manifest = async (folder: string, version: string): Promise<void> => {
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ version }));
    };
    await manifest(path.join(dir, 'mac', 'Contents', 'Resources', 'app'), '1.1.0');
    await manifest(path.join(dir, 'win', 'e646868227', 'resources', 'app'), '1.143.1');
    await manifest(path.join(dir, 'two', 'a', 'resources', 'app'), '1.0.0');
    await manifest(path.join(dir, 'two', 'b', 'resources', 'app'), '2.0.0');
    assert.equal(await ide.version(path.join(dir, 'mac', 'Contents', 'MacOS', 'Code')), '1.1.0');
    assert.equal(await ide.version(path.join(dir, 'win', 'Code.exe')), '1.143.1');
    assert.equal(await ide.version(path.join(dir, 'two', 'Code.exe')), null);
    assert.equal(ide.candidates({ SQUADRON_IDE: 'x' })[0], 'x');
  });

  it('rejects raw workers and multiple files before allocating a host', async () => {
    await assert.rejects(ownership.connectWorker({}), /supervis/);
    for (const args of [[], ['a.js', 'b.js'], ['*.js'], ['--inspect', 'a.js']]) {
      assert.throws(() => runner.scenarioArgs(args));
    }
    assert.deepEqual(
      runner.scenarioArgs(['--test-only', '--test-name-pattern=a', 'cafe_lease.smoke.js']),
      ['--test', '--test-only', '--test-name-pattern=a', 'cafe_lease.smoke.js']
    );
  });

  it('orders a selection from the registry and refuses an unknown or repeated name', () => {
    const first = registry.scenarios[0];
    const later = registry.scenarios[2];
    assert.ok(first && later);
    assert.deepEqual(registry.scenarioSelection(), [...registry.scenarios]);
    assert.deepEqual(registry.scenarioSelection([later, first]), [first, later]);
    assert.deepEqual(registry.scenarioSelection([]), []);
    assert.throws(() => registry.scenarioSelection(['missing.smoke']), /unknown smoke scenario/);
    assert.throws(() => registry.scenarioSelection([first, first]), /unknown smoke scenario/);
    assert.throws(() => registry.scenarioSelection('onboarding.smoke'), /unknown smoke scenario/);
  });

  it('refuses to own a pre-existing root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-existing-'));
    try {
      await fs.writeFile(path.join(root, 'sentinel'), 'keep');
      await assert.rejects(ownership.createSupervisor(root), /EEXIST/);
      assert.equal(await fs.readFile(path.join(root, 'sentinel'), 'utf8'), 'keep');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('cancels a successful timeout race', async () => {
    await ownership.bounded(Promise.resolve(), 60_000, 'test');
    assert.ok(!process.getActiveResourcesInfo().includes('Timeout'));
  });
});

async function livePeer(t: TestContext): Promise<{
  supervisor: ownership.Supervisor;
  child: childProcess.ChildProcessWithoutNullStreams;
  ready: { id: string; pid: number };
  command: (text: string) => Promise<{ ok: boolean; error?: string }>;
}> {
  const lease = platform.processes.own();
  const resources: {
    supervisor?: ownership.Supervisor;
    child?: childProcess.ChildProcessWithoutNullStreams;
    closed?: Promise<void>;
  } = {};
  t.after(async () => {
    try {
      try {
        await resources.supervisor?.shutdown();
      } finally {
        if (resources.child && resources.closed) {
          resources.child.kill('SIGKILL');
          await ownership.bounded(resources.closed, 10_000, 'peer close');
        }
      }
      if (resources.supervisor)
        await fs.rm(resources.supervisor.paths.root, { recursive: true, force: true });
    } finally {
      assert.deepEqual((await lease.dispose()).unresolved, [], 'fixture process readers closed');
    }
  });
  const supervisor = await ownership.createSupervisor();
  resources.supervisor = supervisor;
  const peer = childProcess.spawn(
    process.execPath,
    [path.join(outRoot(), 'test', 'smoke', 'cleanup_peer.js')],
    {
      stdio: 'pipe',
      env: {
        ...process.env,
        SQUADRON_SMOKE_SOCKET: supervisor.paths.socket,
        SQUADRON_SMOKE_TOKEN: supervisor.token
      }
    }
  );
  resources.child = peer;
  resources.closed = new Promise<void>((resolve) => peer.once('close', () => resolve()));
  const lines = readline.createInterface({ input: peer.stdout })[Symbol.asyncIterator]();
  const next = async (): Promise<unknown> => {
    const line = await ownership.bounded(lines.next(), 10_000, 'peer reply');
    assert.ok(!line.done, 'peer exited before reply');
    return JSON.parse(line.value) as unknown;
  };
  const deadline = performance.now() + 10_000;
  const ready = (await next()) as { id: string; pid: number };
  if (testPlatform() === 'win32') {
    // Host stdout can precede the supervisor's live-edge witness scan.
    while (
      ![...(supervisor.launches.get(ready.id)?.members.values() ?? [])].some(
        (member) => member.ppid === ready.pid && member.command?.includes('setInterval')
      )
    ) {
      assert.ok(performance.now() < deadline, 'launched host witnessed before worker loss');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return {
    supervisor,
    child: peer,
    ready,
    command: async (text) => {
      peer.stdin.write(text + '\n');
      return (await next()) as { ok: boolean; error?: string };
    }
  };
}

describe('smoke supervisor subprocess boundary', () => {
  it(
    'exits with the startup error when the manual IDE binary is missing',
    { timeout: 30_000 },
    async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-missing-ide-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const missing = path.join(root, 'missing-ide');
      const child = childProcess.spawn(
        process.execPath,
        [path.join(outRoot(), 'test', 'smoke/dev_host.js')],
        {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) => !key.startsWith('SQUADRON_SMOKE_'))
            ),
            SQUADRON_IDE: missing
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );
      t.after(() => {
        child.kill('SIGTERM');
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const exit = await ownership.bounded(
        new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        }),
        10_000,
        'failed manual launch'
      );
      assert.equal(exit, 1, output);
      assert.ok(output.includes(missing), output);
    }
  );

  it(
    'closes owned processes on worker loss without touching a concurrent run',
    { timeout: 30_000 },
    async (t) => {
      const a = await livePeer(t);
      const b = await livePeer(t);
      const lost = new Promise<void>((resolve) => {
        a.supervisor.onLoss = resolve;
      });
      a.child.kill('SIGKILL');
      await ownership.bounded(lost, 5000, 'worker connection loss');
      await a.supervisor.shutdown();
      assert.equal((await ownership.readProcesses()).has(a.ready.pid), false);
      assert.equal((await b.command('prepare')).ok, true);
      assert.equal((await b.command('finish')).ok, true);
      assert.equal((await b.command('release')).ok, true);
    }
  );

  it(
    'rejects stale and duplicate launch messages, and confirms repeated close',
    { timeout: 30_000 },
    async (t) => {
      const peer = await livePeer(t);
      assert.equal((await peer.command('stale')).ok, false);
      assert.equal((await peer.command('duplicate')).ok, false);
      assert.equal((await peer.command('retired')).ok, false);
      assert.equal((await peer.command('prepare')).ok, true);
      assert.equal((await peer.command('finish')).ok, true);
      assert.equal((await peer.command('finish')).ok, true);
      assert.equal((await peer.command('release')).ok, true);
    }
  );
});

describe('smoke scenario admission', () => {
  it('refuses a missing scenario file before a worker starts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-missing-scenario-'));
    try {
      const calls = path.join(dir, 'calls');
      const entry = path.join(dir, 'e2e.js');
      await fs.writeFile(
        entry,
        `require('node:fs').writeFileSync(${JSON.stringify(calls)}, 'started');\n`
      );
      const ran = childProcess.spawnSync(
        process.execPath,
        [path.join(outRoot(), 'test', 'smoke/runner.js'), entry],
        {
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) =>
                !key.startsWith('SQUADRON_VERIFY_') &&
                !key.startsWith('SQUADRON_RUN') &&
                !key.startsWith('SQUADRON_SMOKE_') &&
                key !== 'NODE_TEST_CONTEXT'
            )
          ),
          encoding: 'utf8',
          timeout: 20_000
        }
      );
      assert.notEqual(ran.status, 0, ran.stderr);
      assert.match(ran.stderr, /ENOENT/);
      assert.equal(ran.stdout, '');
      assert.equal(
        await fs.stat(calls).then(
          () => true,
          () => false
        ),
        false
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
