/**
 * Process consumers over the selected Windows table (processes Step 6, W3.5),
 * model-free, on native named fixtures under a temp home: an owned Claude
 * found by discovery (what `squadron-list` folds), its command status, a
 * terminal-started twin excluded, the Grok refresh refusal's input, and an
 * End by start-checked TerminateProcess confirmed by the next read.
 */

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as platform from '../../core/platform';
import type * as processes from '../../core/platform/processes';
import type * as scanModule from '../../core/scan';
import * as helpers from '../helpers';

const nativeSkip = helpers.testPlatform() !== 'win32' && 'posix: native Windows process consumers';

/** 100 ns units from 1601 to 1970: a table millisecond as the CLI's FILETIME `procStart`. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const filetimeOf = (ms: number): string => String(BigInt(ms) * 10_000n + FILETIME_UNIX_EPOCH);

type Tree = { cli: number; shell?: number; stop(): Promise<void> };

function rowsOf(snapshot: processes.Snapshot): processes.Row[] {
  return snapshot.supported && snapshot.status !== 'failed' ? snapshot.value.rows : [];
}

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

describe('Windows process consumers on native fixtures', { skip: nativeSkip }, () => {
  let home: string;
  let bin: string;
  let scan: typeof scanModule;
  const trees: Tree[] = [];

  before(async () => {
    home = await helpers.tempHome();
    bin = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-consumers-'));
    scan = await import('../../core/scan');
  });
  after(async () => {
    for (const tree of trees) await tree.stop();
    await fs.rm(bin, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /**
   * A `claude.exe` (a copy of `cmd.exe`) whose tool shell is a `bash.exe`
   * (a copy of `PING.EXE`), or an idle one waiting on stdin. `/d` is its first
   * argument, so it is not taken for the CLI's plumbing.
   */
  async function claudeTree(withShell: boolean): Promise<Tree> {
    const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const dir = await fs.mkdtemp(path.join(bin, 'tree-'));
    const cli = path.join(dir, 'claude.exe');
    const shell = path.join(dir, 'bash.exe');
    await fs.copyFile(path.join(system, 'cmd.exe'), cli);
    await fs.copyFile(path.join(system, 'PING.EXE'), shell);
    const child = spawn(cli, withShell ? ['/d', '/c', `${shell} -n 121 127.0.0.1`] : ['/d', '/k'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true
    });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const pid = child.pid ?? 0;
    // By image: the CLI's first child may be its conhost.exe, not the shell.
    let shellRow: processes.Row | undefined;
    for (let i = 0; i < 40 && withShell && shellRow === undefined; i++) {
      shellRow = rowsOf(await platform.processes.snapshot()).find(
        (row) => row.ppid === pid && row.image?.toLowerCase() === 'bash.exe'
      );
      if (shellRow === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const shellPid = shellRow?.pid;
    const tree: Tree = {
      cli: pid,
      ...(shellPid === undefined ? {} : { shell: shellPid }),
      async stop() {
        // The shell by its exact start, so a recycled number is left alone.
        const now = rowsOf(await platform.processes.snapshot());
        if (
          shellRow &&
          now.some((row) => row.pid === shellRow?.pid && row.startedAt === shellRow.startedAt)
        )
          kill(shellRow.pid);
        kill(pid);
        child.stdin?.end();
        await closed;
        for (let i = 0; i < 50 && shellRow; i++) {
          const rows = rowsOf(await platform.processes.snapshot());
          if (
            !rows.some((row) => row.pid === shellRow?.pid && row.startedAt === shellRow.startedAt)
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    };
    trees.push(tree);
    return tree;
  }

  it('discovers an owned Claude by its FILETIME start, with command status only while a shell runs', async () => {
    const busy = await claudeTree(true);
    const idle = await claudeTree(false);
    const table = await scan.scanProcesses(true);
    assert.equal(table.complete, true);
    assert.equal(table.startSource, 'win32-filetime-ms-v1');
    assert.ok(table.claude.has(busy.cli), 'the busy claude.exe is a Claude');
    assert.ok(table.claude.has(idle.cli), 'the idle claude.exe is a Claude');
    assert.ok(busy.shell, 'its bash.exe tool shell was seen');
    assert.equal(table.shellParents.has(busy.cli), true);
    // conhost.exe is each console process's ordinary child, never a shell.
    assert.equal(table.shellParents.has(idle.cli), false);

    const sessions = path.join(home, '.claude', 'sessions');
    const write = (pid: number, entrypoint: string, sessionId: string) =>
      helpers.writeJson(path.join(sessions, `${pid}.json`), {
        pid,
        sessionId,
        cwd: path.join(home, 'apps', 'admin'),
        procStart: filetimeOf(table.starts.get(pid) ?? 0),
        entrypoint,
        status: 'idle',
        kind: 'interactive',
        startedAt: Date.now()
      });
    await write(busy.cli, 'sdk-cli', 'owned-busy');
    await write(idle.cli, 'cli', 'typed-in-a-terminal');
    const { discoverAll } = await import('../../core/adapter');
    const found = await discoverAll();
    const owned = found.find((session) => session.pid === busy.cli);
    assert.ok(owned, 'the owned session is discovered on the Windows clock');
    assert.equal(owned.hasCommand, true);
    assert.equal(owned.startedAt, table.starts.get(busy.cli));
    assert.equal(
      found.some((session) => session.pid === idle.cli),
      false,
      'a terminal-started session stays excluded'
    );

    // A pid file whose start is a millisecond off is someone else's number.
    await helpers.writeJson(path.join(sessions, `${busy.cli}.json`), {
      pid: busy.cli,
      sessionId: 'owned-busy',
      cwd: path.join(home, 'apps', 'admin'),
      procStart: filetimeOf((table.starts.get(busy.cli) ?? 0) + 1),
      entrypoint: 'sdk-cli',
      status: 'idle',
      kind: 'interactive'
    });
    assert.equal(
      (await discoverAll()).some((session) => session.pid === busy.cli),
      false
    );
  });

  it('gives the Grok refresh refusal a complete table with the running grok in it', async () => {
    const grok = await helpers.fakeGrok(30);
    try {
      const table = await scan.scanProcesses(true);
      assert.equal(table.complete, true);
      assert.ok(table.grok.has(grok.pid));
    } finally {
      await grok.stop();
    }
  });

  it('ends an owned tree by start-checked TerminateProcess, and the next read proves it', async () => {
    const tree = await claudeTree(true);
    const { endBySignal, Reaps } = await import('../../core/control');
    const before = await scan.scanProcesses(true);
    const startedAt = before.starts.get(tree.cli) ?? 0;
    const members = [tree.cli, ...scan.descendants(tree.cli, before.parents)];
    assert.ok(tree.shell && members.includes(tree.shell));
    const reaps = new Reaps();
    try {
      assert.deepEqual(await endBySignal([{ pid: tree.cli, startedAt }], reaps), ['ended']);
      let gone = false;
      for (let i = 0; i < 40 && !gone; i++) {
        const now = await scan.scanProcesses(true);
        gone =
          now.complete === true &&
          members.every((pid) => now.starts.get(pid) !== before.starts.get(pid));
        if (!gone) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(gone, `members ${members.join(', ')} outlived the End`);
    } finally {
      reaps.dispose();
    }
  });
});
